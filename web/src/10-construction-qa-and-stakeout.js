/**
 * GatheringScans Module 10: Construction QA, Open-Trench Utility 3D Tracer & RTK Stakeout
 * =======================================================================================
 * Implements Milestone 4 & Milestone 5 Civil Engineering & Construction QA tools:
 * 1. 3D Surface Flatness, Levelness & Wall Plumbness Inspector:
 *    - Reference Plane modes: Horizontal, Vertical Plumb, Best-Fit Least Squares
 *    - User-selectable tolerance thresholds (mm)
 *    - Deviation heatmap grid, Pass Rate %, Max High / Max Low 3D pins
 *    - Plumb Tilt Ratio (1:N, mm/m) and ASTM E1155 approximation (F_F / F_L)
 * 2. Open-Trench Buried Utility 3D As-Built Tracer:
 *    - 3D polyline tracing (Invert, Crown, Ground)
 *    - Pipe diameter & type selection (DRAIN, SEWER, WATER, GAS, ELEC, TELECOM)
 *    - Cumulative stationing (0K+000) and segment gradients (% and 1:N)
 *    - Depth of cover evaluation and 3D DXF / CSV export
 * 3. Compare View ΔV Volume Takeoff:
 *    - Polygon-bounded epoch-to-epoch difference volume takeoff
 *    - Mass conservation (BCM, LCM, CCM, Tonnes) and dump truck haulage trips
 * 4. RTK Stakeout Export strictly in Easting, Northing, Elevation (E, N, Z) order:
 *    - PtID, Easting, Northing, Elevation, Code
 *    - Standard CSV, space-delimited TXT (Leica/Trimble), 3D DXF R12
 *    - Printable A4 Construction Field Sheet with sign-off blocks
 *
 * Compliance:
 * - Strictly under 5,000 lines modular ceiling
 * - ZERO Unicode emojis (crisp inline SVGs only)
 * - Comprehensive Bright & Dark Theme Support (via CSS Custom Properties)
 * - Strict 1-word action button labels
 * - TWD97 (121) + TWVD2001 coordinate ordering strictly E, N, Z
 */

(function () {
  "use strict";

  // Crisp inline SVG icons (BIM CAD stroke style, stroke="currentColor", stroke-width="2", fill="none")
  const QA_SVGS = {
    FLATNESS: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M3 12h18"></path><path d="M3 6h18"></path><path d="M3 18h18"></path></svg>`,
    PLUMB: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><line x1="12" y1="2" x2="12" y2="18"></line><circle cx="12" cy="19.5" r="2.5"></circle></svg>`,
    PIPE: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><rect x="2" y="7" width="20" height="10" rx="2"></rect><line x1="6" y1="7" x2="6" y2="17"></line><line x1="18" y1="7" x2="18" y2="17"></line></svg>`,
    STAKEOUT: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><circle cx="12" cy="12" r="9"></circle><path d="M12 3v18"></path><path d="M3 12h18"></path></svg>`,
    COMPARE: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><rect x="2" y="4" width="9" height="16" rx="1"></rect><rect x="13" y="4" width="9" height="16" rx="1"></rect></svg>`,
    CHECK: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    PICK: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"></path><path d="M12 12l9 9"></path><path d="M16 21l5-5"></path></svg>`,
    RESET: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`,
    CSV: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="16" y2="17"></line></svg>`,
    DXF: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`,
    PRINT: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>`,
    ALERT: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`,
    CALC: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><rect x="4" y="2" width="16" height="20" rx="2"></rect><line x1="8" y1="6" x2="16" y2="6"></line><line x1="16" y1="14" x2="16" y2="18"></line><path d="M16 10h.01"></path><path d="M12 10h.01"></path><path d="M8 10h.01"></path><path d="M12 14h.01"></path><path d="M8 14h.01"></path><path d="M12 18h.01"></path><path d="M8 18h.01"></path></svg>`,
  };

  // Safe float parsing helper
  function safeFloat(val, fallback) {
    if (val === undefined || val === null) return fallback;
    const s = String(val).trim();
    if (!s || s.toLowerCase() === "undefined" || s.toLowerCase() === "null" || s.toLowerCase() === "nan") {
      return fallback;
    }
    const f = parseFloat(s);
    return Number.isFinite(f) ? f : fallback;
  }

  // Translation helper
  const t = (zh, en) => (typeof tr === "function" ? tr(zh, en) : zh);

  // Active 3D overlay groups
  let surfaceQa3DGroup = null;
  let utilityTrace3DGroup = null;
  let compareVolume3DGroup = null;
  let stakeout3DGroup = null;

  // Stored state for active tools
  const QA_STATE = {
    surfaceQaPoints: [],
    surfaceQaWallLine: [],
    surfaceQaLastResult: null,
    isPickingFlatnessPoint: false,
    flatnessPlaneMode: "best_fit_3d",
    flatnessToleranceMm: 3.0,
    flatnessVolumeMode: "threshold",
    flatnessDisplayMode: "tiles",
    flatnessShowPass3D: false,
    flatnessCache: null,
    flatnessCancelToken: null,
    utilityTrenchPoints: [],
    utilityLastResult: null,
    isPickingUtilityPoint: false,
    stakeoutPoints: [],
    stakeoutLastResult: null,
    isPickingStakeoutPoint: false,
  };

  function getFlatnessRegulationSpec(tolMm) {
    const tol = Number(tolMm) || 3.0;
    if (tol <= 4.5) {
      return {
        code: "PCC 09611",
        zh: "施工綱要規範 第09611章 整體粉光地坪 (3m直規 ±3mm)",
        en: "PCC Spec Ch.09611 Monolithic Floor Troweling (3m ±3mm)",
        url: "https://www.nlma.gov.tw/filesys/file/chinese/dept/bw2/09611.pdf",
      };
    }
    if (tol <= 8.0) {
      return {
        code: "PCC 09220",
        zh: "施工綱要規範 第09220章 水泥砂漿粉刷 (3m直規 ±6mm)",
        en: "PCC Spec Ch.09220 Cement Mortar Plastering (3m ±6mm)",
        url: "https://www.nlma.gov.tw/uploads/files/b540c458d9a9ace031fb2cec987593c0.pdf",
      };
    }
    if (tol <= 12.5) {
      return {
        code: "PCC 03310",
        zh: "施工綱要規範 第03310章 結構用混凝土模板粗底 (±10mm)",
        en: "PCC Spec Ch.03310 Structural Concrete Formwork (±10mm)",
        url: "https://www.nlma.gov.tw/uploads/files/896a8dbb1440cce3f17b09e0a4b8dcff.pdf",
      };
    }
    return {
      code: "PCC 02742",
      zh: `施工綱要規範 第02742章 道路與鋪面基層公差 (±${Number(tol.toFixed(1))}mm)`,
      en: `PCC Spec Ch.02742 Road & Pavement Base (±${Number(tol.toFixed(1))}mm)`,
      url: "https://www.nlma.gov.tw/uploads/files/5ee2ba58e7e83d1d4345b233fb71d7eb.pdf",
    };
  }

  function clear3DGroup(grp) {
    if (!grp) return null;
    if (window.studioThree) {
      if (window.studioThree.overlayGroup) window.studioThree.overlayGroup.remove(grp);
      if (window.studioThree.scene) window.studioThree.scene.remove(grp);
    }
    grp.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    });
    return null;
  }

  function cancelActiveFlatnessJob() {
    if (QA_STATE.flatnessCancelToken) {
      QA_STATE.flatnessCancelToken.cancelled = true;
      QA_STATE.flatnessCancelToken = null;
    }
  }

  function onQaPanelsClosed(nextTool) {
    const active = String(nextTool || "");
    if (typeof window.isStudioGroup1Tool === "function" && window.isStudioGroup1Tool(active)) {
      QA_STATE.isPickingFlatnessPoint = false;
      QA_STATE.isPickingUtilityPoint = false;
      QA_STATE.isPickingComparePoly = false;
      QA_STATE.isPickingStakeoutPoint = false;
      return;
    }
    if (active !== "drainage" && typeof window.clearDrainageVisuals3D === "function") {
      window.clearDrainageVisuals3D();
    }
    if (active !== "flatness") {
      cancelActiveFlatnessJob();
      QA_STATE.isPickingFlatnessPoint = false;
      surfaceQa3DGroup = clear3DGroup(surfaceQa3DGroup);
    }
    if (active !== "trench") {
      QA_STATE.isPickingUtilityPoint = false;
      utilityTrace3DGroup = clear3DGroup(utilityTrace3DGroup);
    }
    if (active !== "compare_volume") {
      QA_STATE.isPickingComparePoly = false;
      compareVolume3DGroup = clear3DGroup(compareVolume3DGroup);
    }
    if (active !== "stakeout") {
      QA_STATE.isPickingStakeoutPoint = false;
      stakeout3DGroup = clear3DGroup(stakeout3DGroup);
    }
    if (window.studioThree && window.studioThree.renderer && window.studioThree.scene && window.studioThree.camera) {
      window.studioThree.renderer.render(window.studioThree.scene, window.studioThree.camera);
    }
  }

  // =========================================================================
  // 1. POLYGON-BASED 3D SURFACE FLATNESS, PLUMBNESS & MATERIAL TAKEOFF
  // =========================================================================

  /**
   * Exact 3x3 Symmetric Jacobi Eigenvalue & Eigenvector Solver.
   * Returns eigenvalues [d0, d1, d2] and orthonormal eigenvectors [v0, v1, v2] sorted ascending by eigenvalue.
   */
  function solveSymmetric3x3Eigen(m00, m01, m02, m11, m12, m22) {
    const A = [
      [m00, m01, m02],
      [m01, m11, m12],
      [m02, m12, m22],
    ];
    const V = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    for (let iter = 0; iter < 18; iter++) {
      let p = 0, q = 1;
      let maxOff = Math.abs(A[0][1]);
      if (Math.abs(A[0][2]) > maxOff) { maxOff = Math.abs(A[0][2]); p = 0; q = 2; }
      if (Math.abs(A[1][2]) > maxOff) { maxOff = Math.abs(A[1][2]); p = 1; q = 2; }
      if (maxOff < 1e-12) break;
      const app = A[p][p], aqq = A[q][q], apq = A[p][q];
      const phi = 0.5 * Math.atan2(2.0 * apq, aqq - app);
      const c = Math.cos(phi), s = Math.sin(phi);
      for (let i = 0; i < 3; i++) {
        if (i !== p && i !== q) {
          const aip = A[i][p], aiq = A[i][q];
          A[i][p] = A[p][i] = c * aip - s * aiq;
          A[i][q] = A[q][i] = s * aip + c * aiq;
        }
      }
      A[p][p] = c * c * app - 2.0 * s * c * apq + s * s * aqq;
      A[q][q] = s * s * app + 2.0 * s * c * apq + c * c * aqq;
      A[p][q] = A[q][p] = 0.0;
      for (let i = 0; i < 3; i++) {
        const vip = V[i][p], viq = V[i][q];
        V[i][p] = c * vip - s * viq;
        V[i][q] = s * vip + c * viq;
      }
    }
    const items = [0, 1, 2].map((col) => ({
      val: A[col][col],
      vec: { x: V[0][col], y: V[1][col], z: V[2][col] },
    }));
    items.sort((a, b) => a.val - b.val);
    return items;
  }

  function vecNorm(v) {
    const len = Math.hypot(v.x, v.y, v.z) || 1.0;
    return { x: v.x / len, y: v.y / len, z: v.z / len };
  }

  function vecCross(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  }

  function vecDot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  /**
   * Fits a 3D reference plane to a point set (in local Three.js Y-up coordinates).
   * Supports:
   * - "best_fit_3d" (Default): Orthogonal PCA Best-Fit Plane (adapts to floors, ramps, and vertical walls)
   * - "horizontal": Horizontal Floor Plane (normal = +Y)
   * - "vertical_plumb": Vertical Plumb Wall Plane (normal horizontal in XZ plane)
   */
  function fitFlatnessReferencePlane(points, planeMode = "best_fit_3d") {
    const nPts = Array.isArray(points) ? points.length : 0;
    if (nPts === 0) {
      return {
        center: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
        uAxis: { x: 1, y: 0, z: 0 },
        vAxis: { x: 0, y: 0, z: 1 },
        planeMode,
        slopePct: 0,
        slopeDeg: 0,
        tiltRatio: "1:INF",
        plumbMmPerM: 0,
        azimuthDeg: 0,
        surfaceClassZh: "水平面",
        surfaceClassEn: "Horizontal",
      };
    }

    const computeWeightedCentroidAndCov = (weightFn) => {
      let mCx = 0, mCy = 0, mCz = 0, mWSum = 0;
      for (let i = 0; i < nPts; i++) {
        const p = points[i];
        const w = weightFn(p, i);
        mCx += p.x * w;
        mCy += p.y * w;
        mCz += p.z * w;
        mWSum += w;
      }
      if (mWSum <= 1e-12) mWSum = 1.0;
      mCx /= mWSum;
      mCy /= mWSum;
      mCz /= mWSum;
      let m00 = 0, m01 = 0, m02 = 0, m11 = 0, m12 = 0, m22 = 0;
      for (let i = 0; i < nPts; i++) {
        const p = points[i];
        const w = weightFn(p, i);
        const dx = p.x - mCx, dy = p.y - mCy, dz = p.z - mCz;
        m00 += w * dx * dx;
        m01 += w * dx * dy;
        m02 += w * dx * dz;
        m11 += w * dy * dy;
        m12 += w * dy * dz;
        m22 += w * dz * dz;
      }
      return { cx: mCx, cy: mCy, cz: mCz, c00: m00, c01: m01, c02: m02, c11: m11, c12: m12, c22: m22 };
    };

    const solveNormalFromCov = (cov) => {
      if (planeMode === "horizontal") {
        return { x: 0, y: 1, z: 0 };
      }
      if (planeMode === "vertical_plumb") {
        const phi = 0.5 * Math.atan2(2.0 * cov.c02, cov.c00 - cov.c22);
        const ux = Math.cos(phi), uz = Math.sin(phi);
        return vecNorm({ x: -uz, y: 0, z: ux });
      }
      const eig = solveSymmetric3x3Eigen(cov.c00, cov.c01, cov.c02, cov.c11, cov.c12, cov.c22);
      return vecNorm(eig[0].vec);
    };

    // Pass 1: Initial weighted PCA fit
    let cov = computeWeightedCentroidAndCov((p) => (Number.isFinite(p.w) && p.w > 0 ? p.w : 1.0));
    let pass1Normal = solveNormalFromCov(cov);

    // Pass 2: Robust IRLS re-weighting (downweights edge curbs/shrubs so plane locks onto dominant slab/wall)
    if (nPts >= 9) {
      const absDevs = new Float64Array(nPts);
      for (let i = 0; i < nPts; i++) {
        const p = points[i];
        absDevs[i] = Math.abs(
          (p.x - cov.cx) * pass1Normal.x +
          (p.y - cov.cy) * pass1Normal.y +
          (p.z - cov.cz) * pass1Normal.z
        );
      }
      const sortedDevs = Array.from(absDevs).sort((a, b) => a - b);
      const medDev = sortedDevs[Math.floor(nPts * 0.5)] || 0.003;
      const huberScale = Math.max(0.006, 2.5 * medDev);
      cov = computeWeightedCentroidAndCov((p, i) => {
        const baseW = Number.isFinite(p.w) && p.w > 0 ? p.w : 1.0;
        const r = absDevs[i] / huberScale;
        return r <= 1.0 ? baseW : baseW / (1.0 + r * r * r * r);
      });
    }

    const cx = cov.cx, cy = cov.cy, cz = cov.cz;
    const c00 = cov.c00, c01 = cov.c01, c02 = cov.c02, c11 = cov.c11, c12 = cov.c12, c22 = cov.c22;
    const center = { x: cx, y: cy, z: cz };

    let normal = { x: 0, y: 1, z: 0 };
    let uAxis = { x: 1, y: 0, z: 0 };
    let vAxis = { x: 0, y: 0, z: 1 };

    if (planeMode === "horizontal") {
      normal = { x: 0, y: 1, z: 0 };
      uAxis = { x: 1, y: 0, z: 0 };
      vAxis = { x: 0, y: 0, z: 1 };
    } else if (planeMode === "vertical_plumb") {
      // 2D PCA in horizontal (X, Z) plane so the normal is strictly horizontal (ny = 0)
      const phi = 0.5 * Math.atan2(2.0 * c02, c00 - c22);
      const ux = Math.cos(phi), uz = Math.sin(phi);
      normal = vecNorm({ x: -uz, y: 0, z: ux });
      if (window.studioThree && window.studioThree.camera) {
        const cam = window.studioThree.camera.position;
        const toCam = { x: cam.x - cx, y: cam.y - cy, z: cam.z - cz };
        if (vecDot(normal, toCam) < 0) {
          normal = { x: -normal.x, y: 0, z: -normal.z };
        }
      }
      uAxis = vecNorm({ x: -normal.z, y: 0, z: normal.x });
      vAxis = { x: 0, y: 1, z: 0 };
    } else {
      // 3D PCA Orthogonal Best-Fit Plane
      const eig = solveSymmetric3x3Eigen(c00, c01, c02, c11, c12, c22);
      normal = vecNorm(eig[0].vec);
      if (Math.abs(normal.y) >= 0.35) {
        if (normal.y < 0) normal = { x: -normal.x, y: -normal.y, z: -normal.z };
      } else if (window.studioThree && window.studioThree.camera) {
        const cam = window.studioThree.camera.position;
        const toCam = { x: cam.x - cx, y: cam.y - cy, z: cam.z - cz };
        if (vecDot(normal, toCam) < 0) {
          normal = { x: -normal.x, y: -normal.y, z: -normal.z };
        }
      }
      uAxis = vecNorm(eig[2].vec);
      // Gram-Schmidt orthogonalize uAxis against normal
      const un = vecDot(uAxis, normal);
      uAxis = vecNorm({ x: uAxis.x - un * normal.x, y: uAxis.y - un * normal.y, z: uAxis.z - un * normal.z });
      vAxis = vecNorm(vecCross(normal, uAxis));
    }

    const nyAbs = Math.min(1.0, Math.abs(normal.y));
    const nh = Math.hypot(normal.x, normal.z);
    const angleFromHorizontalDeg = (Math.atan2(nh, nyAbs) * 180.0) / Math.PI;
    const slopePct = nyAbs > 1e-4 ? (nh / nyAbs) * 100.0 : 999.9;
    // Tilt deviation in mm/m: vertical drop per m run for floors/ramps (<=45 deg), or horizontal lean per m rise for walls (>45 deg)
    const plumbMmPerM = angleFromHorizontalDeg <= 45.0
      ? (nyAbs > 1e-4 ? (nh / nyAbs) * 1000.0 : 0.0)
      : (nh > 1e-4 ? (nyAbs / nh) * 1000.0 : 0.0);
    let tiltRatio = "1:INF";
    if (angleFromHorizontalDeg <= 45.0) {
      if (slopePct >= 0.05) tiltRatio = `1:${Math.max(1, Math.round(100.0 / slopePct))}`;
    } else {
      if (plumbMmPerM >= 0.5) tiltRatio = `1:${Math.max(1, Math.round(1000.0 / plumbMmPerM))}`;
    }
    // Azimuth in TWD97 (Easting = +X, Northing = -Z)
    const azRad = Math.atan2(normal.x, -normal.z);
    const azimuthDeg = ((azRad * 180.0) / Math.PI + 360.0) % 360.0;

    let surfaceClassZh = "水平地坪";
    let surfaceClassEn = "Floor Slab";
    if (angleFromHorizontalDeg > 60.0) {
      surfaceClassZh = "垂直牆面";
      surfaceClassEn = "Vertical Wall";
    } else if (angleFromHorizontalDeg > 5.0) {
      surfaceClassZh = "傾斜坡面";
      surfaceClassEn = "Sloped Ramp";
    }

    return {
      center,
      normal,
      uAxis,
      vAxis,
      planeMode,
      slopePct: Number(slopePct.toFixed(2)),
      slopeDeg: Number(angleFromHorizontalDeg.toFixed(2)),
      tiltRatio,
      plumbMmPerM: Number(plumbMmPerM.toFixed(1)),
      azimuthDeg: Number(azimuthDeg.toFixed(1)),
      surfaceClassZh,
      surfaceClassEn,
    };
  }

  function isPointInPolygon2D(u, v, polyUV) {
    let inside = false;
    for (let i = 0, j = polyUV.length - 1; i < polyUV.length; j = i++) {
      const ui = polyUV[i].u, vi = polyUV[i].v;
      const uj = polyUV[j].u, vj = polyUV[j].v;
      const intersect = (vi > v) !== (vj > v) && u < ((uj - ui) * (v - vi)) / (vj - vi + 1e-12) + ui;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function computePolygonArea2D(polyUV) {
    if (!Array.isArray(polyUV) || polyUV.length < 3) return 0;
    let sum = 0;
    for (let i = 0, j = polyUV.length - 1; i < polyUV.length; j = i++) {
      sum += polyUV[j].u * polyUV[i].v - polyUV[i].u * polyUV[j].v;
    }
    return Math.abs(sum) * 0.5;
  }

  /**
   * Time-sliced background surface sampler inside the 3D polygon.
   * Uses an 8ms per-frame budget via requestAnimationFrame so the UI never lags.
   */
  function computeClientFlatnessPolygonAsync(polyPts, planeMode, onProgress, cancelToken) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(polyPts) || polyPts.length < 3) {
        reject(new Error("Need at least 3 polygon vertices"));
        return;
      }

      // 1. Initial plane from polygon vertices for 2D (u, v) projection
      const initPlane = fitFlatnessReferencePlane(polyPts, planeMode);
      const c0 = initPlane.center;
      const u0 = initPlane.uAxis;
      const v0 = initPlane.vAxis;
      const n0 = initPlane.normal;

      const polyUV = polyPts.map((p) => {
        const dx = p.x - c0.x, dy = p.y - c0.y, dz = p.z - c0.z;
        return {
          u: dx * u0.x + dy * u0.y + dz * u0.z,
          v: dx * v0.x + dy * v0.y + dz * v0.z,
        };
      });

      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (let i = 0; i < polyUV.length; i++) {
        if (polyUV[i].u < minU) minU = polyUV[i].u;
        if (polyUV[i].u > maxU) maxU = polyUV[i].u;
        if (polyUV[i].v < minV) minV = polyUV[i].v;
        if (polyUV[i].v > maxV) maxV = polyUV[i].v;
      }

      // 3D AABB bounded by actual polygon vertex spread along normal (prevents overhanging trees/walls from contaminating slab)
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      let maxPolyAbsN = 0;
      for (let i = 0; i < polyPts.length; i++) {
        const p = polyPts[i];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
        const dx = p.x - c0.x, dy = p.y - c0.y, dz = p.z - c0.z;
        const absN = Math.abs(dx * n0.x + dy * n0.y + dz * n0.z);
        if (absN > maxPolyAbsN) maxPolyAbsN = absN;
      }
      const spanU = Math.max(0.4, maxU - minU);
      const spanV = Math.max(0.4, maxV - minV);
      const normalMargin = Math.min(1.5, Math.max(0.32, maxPolyAbsN + 0.30));
      minX -= normalMargin; maxX += normalMargin;
      minY -= normalMargin; maxY += normalMargin;
      minZ -= normalMargin; maxZ += normalMargin;

      // Grid resolution: 40x40 target cells across polygon bounding box
      const targetGrid = 40;
      const cellSize = Math.max(0.05, Math.min(spanU, spanV) / targetGrid, Math.max(spanU, spanV) / 56);
      const cols = Math.max(4, Math.min(64, Math.ceil(spanU / cellSize)));
      const rows = Math.max(4, Math.min(64, Math.ceil(spanV / cellSize)));
      const du = spanU / cols;
      const dv = spanV / rows;
      const cellAreaM2 = du * dv;

      // Precompute which grid cells lie inside the polygon
      const totalGridCells = rows * cols;
      const cellInside = new Uint8Array(totalGridCells);
      const cellSumX = new Float64Array(totalGridCells);
      const cellSumY = new Float64Array(totalGridCells);
      const cellSumZ = new Float64Array(totalGridCells);
      const cellCount = new Uint32Array(totalGridCells);
      const cellFrontN = new Float32Array(totalGridCells);
      cellFrontN.fill(1e9);
      let activeCellCount = 0;

      for (let r = 0; r < rows; r++) {
        const cv = minV + (r + 0.5) * dv;
        for (let c = 0; c < cols; c++) {
          const cu = minU + (c + 0.5) * du;
          const idx = r * cols + c;
          if (isPointInPolygon2D(cu, cv, polyUV)) {
            cellInside[idx] = 1;
            activeCellCount++;
          }
        }
      }

      // Collect meshes/points from studioThree (tilesRenderer, modelPivot, multiAlignGroup, fallbackGroup)
      // Strictly prefer leaf/finest loaded 3D tiles and exclude hidden ancestor LOD tiles or Google Map helpers
      const meshes = [];
      const pointClouds = [];
      const seenGeoms = new Set();
      const cellFineMask = new Uint8Array(totalGridCells);
      const THREE = window.THREE;

      const isNodeVisibleUnderRoot = (node, rootStop) => {
        let cur = node;
        while (cur) {
          if (cur === rootStop) break;
          if (cur.visible === false) return false;
          cur = cur.parent;
        }
        return true;
      };

      const markGeomsSeen = (rootObj) => {
        if (!rootObj || typeof rootObj.traverse !== "function") return;
        rootObj.traverse((child) => {
          if (child.geometry) seenGeoms.add(child.geometry);
        });
      };

      const collectFromRoot = (rootObj, parentWorldMat = null, isCoarseFallback = false, fromTileTree = false) => {
        if (!rootObj) return;
        const isDetached = Boolean(parentWorldMat && rootObj.parent === null);
        if (!fromTileTree && !isDetached && rootObj.visible === false) return;
        if (typeof rootObj.updateMatrixWorld === "function") rootObj.updateMatrixWorld(true);
        rootObj.traverse((child) => {
          if (!child.geometry || !child.geometry.attributes?.position) return;
          if (!isNodeVisibleUnderRoot(child, rootObj)) return;
          if (
            seenGeoms.has(child.geometry) ||
            child.userData?.isAlignBoxHelper ||
            child.userData?.isGoogleMap ||
            child.name?.includes("googleMap")
          ) {
            return;
          }
          seenGeoms.add(child.geometry);
          let matWorld = child.matrixWorld;
          if (isDetached && THREE) {
            matWorld = new THREE.Matrix4().multiplyMatrices(parentWorldMat, child.matrixWorld);
          }
          if (child.isMesh) meshes.push({ mesh: child, matWorld, isCoarseFallback: Boolean(isCoarseFallback) });
          else if (child.isPoints) pointClouds.push({ pc: child, matWorld, isCoarseFallback: Boolean(isCoarseFallback) });
        });
      };

      const st = window.studioThree;
      if (st) {
        const tr = st.tilesRenderer;
        if (tr && tr.root && st.modelPivot?.visible) {
          st.modelPivot.updateMatrixWorld(true);
          const grpMat = tr.group ? tr.group.matrixWorld : st.modelPivot.matrixWorld;
          const hasAnyLoadedScene = (node) => {
            if (!node) return false;
            if (node.engineData?.scene) return true;
            const ch = node.children;
            if (Array.isArray(ch)) {
              for (let i = 0; i < ch.length; i++) {
                if (hasAnyLoadedScene(ch[i])) return true;
              }
            }
            return false;
          };
          const hasFullCoverageScene = (node) => {
            if (!node) return false;
            if (node.engineData?.scene) return true;
            const ch = node.children;
            return Array.isArray(ch) && ch.length > 0 && ch.every((c) => hasFullCoverageScene(c));
          };
          const walkTile = (node) => {
            if (!node) return;
            const ch = Array.isArray(node.children) ? node.children : [];
            const loadedChildren = ch.filter((c) => hasAnyLoadedScene(c));
            if (loadedChildren.length > 0) {
              for (let i = 0; i < loadedChildren.length; i++) {
                walkTile(loadedChildren[i]);
              }
              if (!ch.every((c) => hasFullCoverageScene(c)) && node.engineData?.scene) {
                collectFromRoot(node.engineData.scene, grpMat, true, true);
              } else if (node.engineData?.scene) {
                // Prevent coarse ancestor LOD tile from being re-collected via st.modelPivot traversal
                markGeomsSeen(node.engineData.scene);
              }
            } else if (node.engineData?.scene) {
              collectFromRoot(node.engineData.scene, grpMat, false, true);
            }
          };
          walkTile(tr.root);
        }
        collectFromRoot(st.modelPivot, null, false, false);
        if (window.STATE?.multiAlign?.active) collectFromRoot(st.multiAlignGroup, null, false, false);
        if (meshes.length === 0 && pointClouds.length === 0) {
          collectFromRoot(st.fallbackGroup, null, true, false);
          collectFromRoot(st.scanRoot, null, false, false);
        }
      }

      // Process fine leaf meshes before any coarse fallback meshes
      meshes.sort((a, b) => Number(a.isCoarseFallback) - Number(b.isCoarseFallback));

      const binCellSample = (idx, lx, ly, lz, signedN, isCoarse) => {
        const absN = Math.abs(signedN);
        if (absN > normalMargin) return;
        if (!cellInside[idx]) return;
        if (isCoarse && cellFineMask[idx]) return;
        if (!isCoarse && !cellFineMask[idx] && cellCount[idx] > 0) {
          cellCount[idx] = 0;
          cellSumX[idx] = 0;
          cellSumY[idx] = 0;
          cellSumZ[idx] = 0;
          cellFrontN[idx] = 1e9;
        }
        if (!isCoarse) cellFineMask[idx] = 1;
        // Prefer the surface layer closest to the user-clicked polygon plane (|signedN| smallest),
        // rejecting overhanging bushes/eaves or back-wall layers > 0.14m away from the active surface
        if (cellCount[idx] > 0) {
          const prevBestAbs = Math.abs(cellFrontN[idx]);
          if (absN < prevBestAbs - 0.14) {
            cellSumX[idx] = lx;
            cellSumY[idx] = ly;
            cellSumZ[idx] = lz;
            cellCount[idx] = 1;
            cellFrontN[idx] = signedN;
            return;
          }
          if (absN > prevBestAbs + 0.14) {
            return;
          }
          if (absN < prevBestAbs) cellFrontN[idx] = signedN;
        } else {
          cellFrontN[idx] = signedN;
        }
        cellSumX[idx] += lx;
        cellSumY[idx] += ly;
        cellSumZ[idx] += lz;
        cellCount[idx] += 1;
      };

      const binLocalPoint = (lx, ly, lz, isCoarse = false) => {
        if (lx < minX || lx > maxX || ly < minY || ly > maxY || lz < minZ || lz > maxZ) return;
        const dx = lx - c0.x, dy = ly - c0.y, dz = lz - c0.z;
        const signedN = dx * n0.x + dy * n0.y + dz * n0.z;
        if (Math.abs(signedN) > normalMargin) return;
        const pu = dx * u0.x + dy * u0.y + dz * u0.z;
        const pv = dx * v0.x + dy * v0.y + dz * v0.z;
        if (pu < minU || pu > maxU || pv < minV || pv > maxV) return;
        const c = Math.min(cols - 1, Math.max(0, Math.floor((pu - minU) / du)));
        const r = Math.min(rows - 1, Math.max(0, Math.floor((pv - minV) / dv)));
        const idx = r * cols + c;
        binCellSample(idx, lx, ly, lz, signedN, isCoarse);
      };

      // Build work queue over meshes + point clouds
      let meshIdx = 0;
      let triCursor = 0;
      let ptCloudIdx = 0;
      let ptCursor = 0;

      // Estimate total work units for smooth progress reporting
      let totalTriangles = 0;
      for (let i = 0; i < meshes.length; i++) {
        const g = meshes[i].mesh.geometry;
        totalTriangles += g.index ? Math.floor(g.index.count / 3) : Math.floor(g.attributes.position.count / 3);
      }
      let totalPoints = 0;
      for (let i = 0; i < pointClouds.length; i++) {
        totalPoints += pointClouds[i].pc.geometry.attributes.position.count;
      }
      const totalUnits = Math.max(1, totalTriangles + totalPoints);
      let processedUnits = 0;

      const vA = THREE ? new THREE.Vector3() : { x: 0, y: 0, z: 0 };
      const vB = THREE ? new THREE.Vector3() : { x: 0, y: 0, z: 0 };
      const vC = THREE ? new THREE.Vector3() : { x: 0, y: 0, z: 0 };

      const scheduleNextChunk = () => {
        let fired = false;
        const runOnce = () => {
          if (fired) return;
          fired = true;
          processChunk();
        };
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(runOnce);
        }
        setTimeout(runOnce, 4);
      };

      const processChunk = () => {
        if (cancelToken && cancelToken.cancelled) {
          reject(new Error("cancelled"));
          return;
        }
        const tStart = performance.now();
        const budgetMs = 8.0;

        while (meshIdx < meshes.length && performance.now() - tStart < budgetMs) {
          const entry = meshes[meshIdx];
          const mesh = entry.mesh;
          const isCoarse = Boolean(entry.isCoarseFallback);
          const geom = mesh.geometry;
          const posAttr = geom.attributes.position;
          const idxAttr = geom.index;
          const matWorld = entry.matWorld || mesh.matrixWorld;
          const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);
          const batchEnd = Math.min(triCount, triCursor + 1500);

          for (let t = triCursor; t < batchEnd; t++) {
            const i0 = idxAttr ? idxAttr.getX(t * 3) : t * 3;
            const i1 = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
            const i2 = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;

            vA.fromBufferAttribute(posAttr, i0).applyMatrix4(matWorld);
            vB.fromBufferAttribute(posAttr, i1).applyMatrix4(matWorld);
            vC.fromBufferAttribute(posAttr, i2).applyMatrix4(matWorld);

            // Fast triangle AABB reject
            if (
              Math.max(vA.x, vB.x, vC.x) < minX || Math.min(vA.x, vB.x, vC.x) > maxX ||
              Math.max(vA.y, vB.y, vC.y) < minY || Math.min(vA.y, vB.y, vC.y) > maxY ||
              Math.max(vA.z, vB.z, vC.z) < minZ || Math.min(vA.z, vB.z, vC.z) > maxZ
            ) {
              continue;
            }

            // Skip opposite-facing back-wall or floor surfaces when sampling a steep/vertical polygon
            const e1x = vB.x - vA.x, e1y = vB.y - vA.y, e1z = vB.z - vA.z;
            const e2x = vC.x - vA.x, e2y = vC.y - vA.y, e2z = vC.z - vA.z;
            const tnx = e1y * e2z - e1z * e2y;
            const tny = e1z * e2x - e1x * e2z;
            const tnz = e1x * e2y - e1y * e2x;
            const tnLen = Math.hypot(tnx, tny, tnz);
            if (tnLen > 1e-6) {
              const cosAngle = Math.abs(tnx * n0.x + tny * n0.y + tnz * n0.z) / tnLen;
              if (cosAngle < 0.35) continue;
            }

            const dxA = vA.x - c0.x, dyA = vA.y - c0.y, dzA = vA.z - c0.z;
            const uA = dxA * u0.x + dyA * u0.y + dzA * u0.z;
            const vA_uv = dxA * v0.x + dyA * v0.y + dzA * v0.z;
            const nA = dxA * n0.x + dyA * n0.y + dzA * n0.z;

            const dxB = vB.x - c0.x, dyB = vB.y - c0.y, dzB = vB.z - c0.z;
            const uB = dxB * u0.x + dyB * u0.y + dzB * u0.z;
            const vB_uv = dxB * v0.x + dyB * v0.y + dzB * v0.z;
            const nB = dxB * n0.x + dyB * n0.y + dzB * n0.z;

            const dxC = vC.x - c0.x, dyC = vC.y - c0.y, dzC = vC.z - c0.z;
            const uC = dxC * u0.x + dyC * u0.y + dzC * u0.z;
            const vC_uv = dxC * v0.x + dyC * v0.y + dzC * v0.z;
            const nC = dxC * n0.x + dyC * n0.y + dzC * n0.z;

            if (Math.min(nA, nB, nC) > normalMargin || Math.max(nA, nB, nC) < -normalMargin) continue;
            const uMinTri = Math.min(uA, uB, uC), uMaxTri = Math.max(uA, uB, uC);
            const vMinTri = Math.min(vA_uv, vB_uv, vC_uv), vMaxTri = Math.max(vA_uv, vB_uv, vC_uv);
            if (uMaxTri < minU || uMinTri > maxU || vMaxTri < minV || vMinTri > maxV) continue;

            // Bin vertices and centroid (captures micro-triangles smaller than cell size)
            binLocalPoint(vA.x, vA.y, vA.z, isCoarse);
            binLocalPoint(vB.x, vB.y, vB.z, isCoarse);
            binLocalPoint(vC.x, vC.y, vC.z, isCoarse);
            binLocalPoint(
              (vA.x + vB.x + vC.x) / 3.0,
              (vA.y + vB.y + vC.y) / 3.0,
              (vA.z + vB.z + vC.z) / 3.0,
              isCoarse
            );

            // Exact 2D barycentric triangle rasterization in (u, v) grid coordinates
            // Guarantees 100% of mesh-covered interior cells are populated without holes regardless of triangle size
            const denom = (vB_uv - vC_uv) * (uA - uC) + (uC - uB) * (vA_uv - vC_uv);
            if (Math.abs(denom) > 1e-10) {
              const invDenom = 1.0 / denom;
              const cMin = Math.max(0, Math.floor((uMinTri - minU) / du));
              const cMax = Math.min(cols - 1, Math.floor((uMaxTri - minU) / du));
              const rMin = Math.max(0, Math.floor((vMinTri - minV) / dv));
              const rMax = Math.min(rows - 1, Math.floor((vMaxTri - minV) / dv));
              for (let r = rMin; r <= rMax; r++) {
                const cv = minV + (r + 0.5) * dv;
                for (let c = cMin; c <= cMax; c++) {
                  const idx = r * cols + c;
                  if (!cellInside[idx]) continue;
                  if (isCoarse && cellFineMask[idx]) continue;
                  const cu = minU + (c + 0.5) * du;
                  const w0 = ((vB_uv - vC_uv) * (cu - uC) + (uC - uB) * (cv - vC_uv)) * invDenom;
                  const w1 = ((vC_uv - vA_uv) * (cu - uC) + (uA - uC) * (cv - vC_uv)) * invDenom;
                  const w2 = 1.0 - w0 - w1;
                  if (w0 >= -0.02 && w1 >= -0.02 && w2 >= -0.02) {
                    const ix = w0 * vA.x + w1 * vB.x + w2 * vC.x;
                    const iy = w0 * vA.y + w1 * vB.y + w2 * vC.y;
                    const iz = w0 * vA.z + w1 * vB.z + w2 * vC.z;
                    const iSignedN = w0 * nA + w1 * nB + w2 * nC;
                    binCellSample(idx, ix, iy, iz, iSignedN, isCoarse);
                  }
                }
              }
            }
          }

          processedUnits += batchEnd - triCursor;
          triCursor = batchEnd;
          if (triCursor >= triCount) {
            meshIdx++;
            triCursor = 0;
          }
        }

        while (meshIdx >= meshes.length && ptCloudIdx < pointClouds.length && performance.now() - tStart < budgetMs) {
          const pcEntry = pointClouds[ptCloudIdx];
          const pc = pcEntry.pc;
          const isCoarse = Boolean(pcEntry.isCoarseFallback);
          const geom = pc.geometry;
          const posAttr = geom.attributes.position;
          const matWorld = pcEntry.matWorld || pc.matrixWorld;
          const ptCount = posAttr.count;
          const batchEnd = Math.min(ptCount, ptCursor + 4000);

          for (let i = ptCursor; i < batchEnd; i++) {
            vA.fromBufferAttribute(posAttr, i).applyMatrix4(matWorld);
            binLocalPoint(vA.x, vA.y, vA.z, isCoarse);
          }

          processedUnits += batchEnd - ptCursor;
          ptCursor = batchEnd;
          if (ptCursor >= ptCount) {
            ptCloudIdx++;
            ptCursor = 0;
          }
        }

        if (typeof onProgress === "function") {
          const pct = Math.min(98, Math.round((processedUnits / totalUnits) * 100));
          onProgress(pct);
        }

        if (meshIdx < meshes.length || ptCloudIdx < pointClouds.length) {
          scheduleNextChunk();
          return;
        }

        // Fill any isolated 1-cell seam cracks surrounded by >= 4 valid neighbor cells
        const origCount = new Uint32Array(cellCount);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            if (!cellInside[idx] || origCount[idx] > 0) continue;
            let nx = 0, ny = 0, nz = 0, nValid = 0;
            for (let dr = -1; dr <= 1; dr++) {
              const nr = r + dr;
              if (nr < 0 || nr >= rows) continue;
              for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const nc = c + dc;
                if (nc < 0 || nc >= cols) continue;
                const nIdx = nr * cols + nc;
                if (origCount[nIdx] > 0) {
                  const invN = 1.0 / origCount[nIdx];
                  nx += cellSumX[nIdx] * invN;
                  ny += cellSumY[nIdx] * invN;
                  nz += cellSumZ[nIdx] * invN;
                  nValid++;
                }
              }
            }
            if (nValid >= 4) {
              cellSumX[idx] = nx / nValid;
              cellSumY[idx] = ny / nValid;
              cellSumZ[idx] = nz / nValid;
              cellCount[idx] = 1;
            }
          }
        }

        // Finalize sampled cells
        const sampledCells = [];
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            if (!cellInside[idx]) continue;
            if (cellCount[idx] > 0) {
              const inv = 1.0 / cellCount[idx];
              sampledCells.push({
                r,
                c,
                u: minU + (c + 0.5) * du,
                v: minV + (r + 0.5) * dv,
                x: cellSumX[idx] * inv,
                y: cellSumY[idx] * inv,
                z: cellSumZ[idx] * inv,
                w: cellAreaM2,
              });
            }
          }
        }

        // Fallback if polygon was drawn over sparse/unloaded mesh region: interpolate from polygon vertices + raycast
        if (sampledCells.length < 4) {
          for (let r = 0; r < rows; r++) {
            const cv = minV + (r + 0.5) * dv;
            for (let c = 0; c < cols; c++) {
              const cu = minU + (c + 0.5) * du;
              const idx = r * cols + c;
              if (!cellInside[idx]) continue;
              // Inverse distance weight from polygon vertices in (u, v)
              let wx = 0, wy = 0, wz = 0, wTot = 0;
              for (let k = 0; k < polyPts.length; k++) {
                const distUV = Math.hypot(cu - polyUV[k].u, cv - polyUV[k].v) + 0.05;
                const wk = 1.0 / (distUV * distUV);
                wx += polyPts[k].x * wk;
                wy += polyPts[k].y * wk;
                wz += polyPts[k].z * wk;
                wTot += wk;
              }
              sampledCells.push({
                r,
                c,
                u: cu,
                v: cv,
                x: wx / wTot,
                y: wy / wTot,
                z: wz / wTot,
                w: cellAreaM2,
              });
            }
          }
        }

        // Fit the exact reference plane to the sampled surface points inside the polygon
        const fittedPlane = fitFlatnessReferencePlane(sampledCells, planeMode);
        const fc = fittedPlane.center;
        const fn = fittedPlane.normal;
        // Lock fittedPlane in-plane basis (fu, fv) to the orthogonal projection of the grid basis (u0, v0) onto fn
        // so that every cell (r, c) sits on a strictly uniform, axis-aligned orthogonal lattice with zero rotation mismatch.
        const u0DotN = vecDot(u0, fn);
        let fu = vecNorm({
          x: u0.x - u0DotN * fn.x,
          y: u0.y - u0DotN * fn.y,
          z: u0.z - u0DotN * fn.z,
        });
        let fv = vecNorm(vecCross(fn, fu));
        if (vecDot(fv, v0) < 0) {
          fv = { x: -fv.x, y: -fv.y, z: -fv.z };
        }
        fittedPlane.uAxis = fu;
        fittedPlane.vAxis = fv;

        const c0DistN = (c0.x - fc.x) * fn.x + (c0.y - fc.y) * fn.y + (c0.z - fc.z) * fn.z;
        const planeOrigX = c0.x - c0DistN * fn.x;
        const planeOrigY = c0.y - c0DistN * fn.y;
        const planeOrigZ = c0.z - c0DistN * fn.z;

        const originTwd = typeof localToTwd97 === "function" ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };

        let sumSqMm = 0;
        let maxHigh = null;
        let maxLow = null;

        for (let i = 0; i < sampledCells.length; i++) {
          const cell = sampledCells[i];
          const dx = cell.x - fc.x;
          const dy = cell.y - fc.y;
          const dz = cell.z - fc.z;
          const devM = dx * fn.x + dy * fn.y + dz * fn.z;
          const devMm = devM * 1000.0;
          cell.devM = devM;
          cell.devMm = devMm;
          cell.planeU = cell.u;
          cell.planeV = cell.v;
          // Exact regular local (u, v) grid center on the best-fit plane (eliminates random triangle-centroid jitter)
          cell.planeX = planeOrigX + cell.u * fu.x + cell.v * fv.x;
          cell.planeY = planeOrigY + cell.u * fu.y + cell.v * fv.y;
          cell.planeZ = planeOrigZ + cell.u * fu.z + cell.v * fv.z;
          // Regular-grid 3D surface point displaced along normal by devM
          cell.x = cell.planeX + devM * fn.x;
          cell.y = cell.planeY + devM * fn.y;
          cell.z = cell.planeZ + devM * fn.z;
          cell.e = Number((originTwd.e + cell.x).toFixed(3));
          cell.n = Number((originTwd.n - cell.z).toFixed(3));
          cell.h = Number((originTwd.h + cell.y).toFixed(3));
          sumSqMm += devMm * devMm;

          if (!maxHigh || devMm > maxHigh.devMm) maxHigh = cell;
          if (!maxLow || devMm < maxLow.devMm) maxLow = cell;
        }

        const nSamples = Math.max(1, sampledCells.length);
        const rmsMm = Math.sqrt(sumSqMm / nSamples);
        // ASTM E1155 F_F / F_L approximation from local curvature & levelness variance
        let curvSumSq = 0, curvCnt = 0;
        for (let i = 2; i < sampledCells.length; i++) {
          const q = Math.abs(sampledCells[i].devMm - 2.0 * sampledCells[i - 1].devMm + sampledCells[i - 2].devMm);
          curvSumSq += q * q;
          curvCnt++;
        }
        const rmsCurvMm = curvCnt > 0 ? Math.sqrt(curvSumSq / curvCnt) : Math.max(1.2, rmsMm * 0.8);
        const ffVal = Number(Math.min(120.0, Math.max(8.0, 115.0 / Math.max(1.1, rmsCurvMm))).toFixed(1));
        const flVal = Number(Math.min(100.0, Math.max(6.0, 95.0 / Math.max(1.2, rmsMm))).toFixed(1));

        const polygonArea2DM2 = computePolygonArea2D(polyUV);
        const effectiveCellAreaM2 = sampledCells.length > 0 && polygonArea2DM2 > 0
          ? polygonArea2DM2 / sampledCells.length
          : cellAreaM2;

        if (typeof onProgress === "function") onProgress(100);

        resolve({
          scanId: (window.STATE && window.STATE.activeScanId) || "scan",
          polyPts: polyPts.map((p) => ({ x: p.x, y: p.y, z: p.z })),
          polyUV,
          plane: fittedPlane,
          cells: sampledCells,
          du,
          dv,
          cellAreaM2: effectiveCellAreaM2,
          totalAreaM2: Number((sampledCells.length * effectiveCellAreaM2).toFixed(2)),
          rmsMm: Number(rmsMm.toFixed(2)),
          ffFlatness: ffVal,
          flLevelness: flVal,
          maxHigh,
          maxLow,
          spanU,
          spanV,
        });
      };

      scheduleNextChunk();
    });
  }

  /**
   * Instantaneous (< 1 ms) recalculation of Pass Rate, Protruding/Excess Volume,
   * Intruding/Lacking Volume, Net Material, and 3D Overlay when adjusting the Tolerance Slider.
   * Supports 3 volume takeoff modes:
   * - "threshold": Beyond ±Tolerance threshold (|d| - T)
   * - "zero_plane": Full volume of out-of-spec zones to 0mm reference plane (|d|)
   * - "fill_only": Self-leveling / mortar fill across polygon up to max high peak (maxHigh.devM - dM, no grinding)
   */
  function evaluateCachedFlatnessWithTolerance(cache, tolMm, volMode = "threshold") {
    if (!cache || !Array.isArray(cache.cells) || cache.cells.length === 0) return null;
    const tolM = Math.max(0.0001, tolMm / 1000.0);
    const cellA = cache.cellAreaM2 || 0.04;
    const cells = cache.cells;
    const maxHighDevM = cache.maxHigh ? Math.max(0, Number(cache.maxHigh.devM) || 0) : 0;

    let passCount = 0;
    let highCount = 0;
    let lowCount = 0;
    let excessVolM3 = 0;
    let lackingVolM3 = 0;

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const dMm = c.devMm;
      const dM = c.devM;
      if (dMm > tolMm) {
        highCount++;
        c.status = "high";
        if (volMode !== "fill_only") {
          const effDepthM = volMode === "zero_plane" ? dM : Math.max(0, dM - tolM);
          excessVolM3 += effDepthM * cellA;
        }
      } else if (dMm < -tolMm) {
        lowCount++;
        c.status = "low";
        if (volMode !== "fill_only") {
          const effDepthM = volMode === "zero_plane" ? Math.abs(dM) : Math.max(0, Math.abs(dM) - tolM);
          lackingVolM3 += effDepthM * cellA;
        }
      } else {
        passCount++;
        c.status = "pass";
      }
      if (volMode === "fill_only") {
        lackingVolM3 += Math.max(0, maxHighDevM - dM) * cellA;
      }
    }

    const totalPts = cells.length;
    const passRatePct = Number(((passCount / totalPts) * 100.0).toFixed(1));
    const highAreaM2 = Number((highCount * cellA).toFixed(2));
    const lowAreaM2 = Number((lowCount * cellA).toFixed(2));
    const highAreaPct = Number(((highCount / totalPts) * 100.0).toFixed(1));
    const lowAreaPct = Number(((lowCount / totalPts) * 100.0).toFixed(1));

    const excessLiters = Number((excessVolM3 * 1000.0).toFixed(2));
    const lackingLiters = Number((lackingVolM3 * 1000.0).toFixed(2));
    const netVolM3 = lackingVolM3 - excessVolM3;
    const netLiters = Number((netVolM3 * 1000.0).toFixed(2));
    // Standard 25kg dry-mix cement mortar bag yields ~13.5 Liters of wet mortar
    const estMortarBags25kg = lackingLiters > 0.05 ? Math.max(1, Math.ceil(lackingLiters / 13.5)) : 0;

    return {
      scan_id: cache.scanId,
      reference_mode: cache.plane.planeMode,
      tolerance_mm: tolMm,
      volume_mode: volMode,
      total_points: totalPts,
      pass_count: passCount,
      high_count: highCount,
      low_count: lowCount,
      pass_rate_pct: passRatePct,
      rms_dev_mm: cache.rmsMm,
      total_area_m2: cache.totalAreaM2,
      high_area_m2: highAreaM2,
      high_area_pct: highAreaPct,
      low_area_m2: lowAreaM2,
      low_area_pct: lowAreaPct,
      excess_volume_m3: Number(excessVolM3.toFixed(4)),
      excess_volume_liters: excessLiters,
      lacking_volume_m3: Number(lackingVolM3.toFixed(4)),
      lacking_volume_liters: lackingLiters,
      net_volume_m3: Number(netVolM3.toFixed(4)),
      net_volume_liters: netLiters,
      est_mortar_bags_25kg: estMortarBags25kg,
      max_high: cache.maxHigh
        ? {
            e: cache.maxHigh.e,
            n: cache.maxHigh.n,
            h: cache.maxHigh.h,
            dev_mm: Number(cache.maxHigh.devMm.toFixed(1)),
          }
        : { e: 0, n: 0, h: 0, dev_mm: 0 },
      max_low: cache.maxLow
        ? {
            e: cache.maxLow.e,
            n: cache.maxLow.n,
            h: cache.maxLow.h,
            dev_mm: Number(cache.maxLow.devMm.toFixed(1)),
          }
        : { e: 0, n: 0, h: 0, dev_mm: 0 },
      astm_e1155: {
        ff_flatness: cache.ffFlatness,
        fl_levelness: cache.flLevelness,
      },
      plumb_tilt: {
        tilt_ratio: cache.plane.tiltRatio,
        plumb_mm_per_m: cache.plane.plumbMmPerM,
        slope_pct: cache.plane.slopePct,
        slope_deg: cache.plane.slopeDeg,
        azimuth_deg: cache.plane.azimuthDeg,
        surface_class_zh: cache.plane.surfaceClassZh,
        surface_class_en: cache.plane.surfaceClassEn,
      },
    };
  }

  /**
   * Renders in-progress draft polygon vertices (V1 red, V2..Vn blue) and polyline while drawing.
   */
  function refreshFlatnessDraftVisuals() {
    if (!window.studioThree || !window.studioThree.scene || !window.THREE) return;
    surfaceQa3DGroup = clear3DGroup(surfaceQa3DGroup);
    surfaceQa3DGroup = new window.THREE.Group();
    surfaceQa3DGroup.name = "GS_SurfaceQA_Overlay";

    const pts = (window.STATE && Array.isArray(window.STATE.measurePoints)) ? window.STATE.measurePoints : [];
    const THREE = window.THREE;

    pts.forEach((p, idx) => {
      const isStart = idx === 0;
      const pinColor = isStart ? 0xff3b30 : 0x0284c7;
      if (typeof add3DPinMarker === "function") {
        add3DPinMarker(p, pinColor, surfaceQa3DGroup);
      } else {
        const sp = new THREE.Mesh(
          new THREE.SphereGeometry(isStart ? 0.22 : 0.16, 14, 14),
          new THREE.MeshBasicMaterial({ color: pinColor, depthTest: false })
        );
        sp.position.copy(p);
        sp.renderOrder = 998;
        surfaceQa3DGroup.add(sp);
      }
    });

    if (pts.length >= 2) {
      const lineGeom = new THREE.BufferGeometry().setFromPoints(pts);
      const lineMat = new THREE.LineBasicMaterial({ color: 0x0284c7, depthTest: false });
      const line = new THREE.Line(lineGeom, lineMat);
      line.renderOrder = 997;
      surfaceQa3DGroup.add(line);
    }

    if (window.studioThree.overlayGroup) {
      window.studioThree.overlayGroup.add(surfaceQa3DGroup);
    } else {
      window.studioThree.scene.add(surfaceQa3DGroup);
    }

    if (typeof update2DBadgePositions === "function") update2DBadgePositions();

    const countBadge = document.getElementById("lblFlatnessVertexCount");
    if (countBadge) {
      countBadge.textContent = pts.length === 0
        ? t("點擊 3+ 點圍成範圍，點紅點 V1 閉合", "Click 3+ pts on surface; click red V1 to close")
        : pts.length < 3
        ? t(`已選 ${pts.length} 點 (再點 ${3 - pts.length} 點)`, `${pts.length} pts (click ${3 - pts.length} more)`)
        : t(`已選 ${pts.length} 點 — 點紅點 V1 或按 Enter 分析`, `${pts.length} pts — click red V1 or Enter to analyze`);
    }
    const btnLock = document.getElementById("btnLockFlatnessPoly");
    if (btnLock) btnLock.disabled = pts.length < 3;
    const btnUndo = document.getElementById("btnUndoFlatnessVertex");
    if (btnUndo) btnUndo.disabled = pts.length === 0;
  }

  /**
   * Renders the 3D Best-Fit Reference Plane Grid + Protruding (Red/Orange) & Intruding (Blue/Cyan)
   * 3D Deviation Tiles or Points on a strictly uniform local (u, v) grid inside the locked polygon.
   */
  function renderPolygonFlatness3DOverlay(cache, metrics, showPass3D = false) {
    if (!window.studioThree || !window.studioThree.scene || !window.THREE || !cache) return;
    const THREE = window.THREE;
    surfaceQa3DGroup = clear3DGroup(surfaceQa3DGroup);
    surfaceQa3DGroup = new THREE.Group();
    surfaceQa3DGroup.name = "GS_SurfaceQA_Overlay";

    const plane = cache.plane;
    const fc = new THREE.Vector3(plane.center.x, plane.center.y, plane.center.z);
    const fn = new THREE.Vector3(plane.normal.x, plane.normal.y, plane.normal.z).normalize();
    const fu = new THREE.Vector3(plane.uAxis.x, plane.uAxis.y, plane.uAxis.z).normalize();
    const fv = new THREE.Vector3(plane.vAxis.x, plane.vAxis.y, plane.vAxis.z).normalize();

    // 1. Locked Polygon Perimeter Loop & Vertex Pin Markers (identical to Area tool)
    const rawPolyPts = (window.STATE && Array.isArray(window.STATE.flatnessPolygonPoints) && window.STATE.flatnessPolygonPoints.length >= 3)
      ? window.STATE.flatnessPolygonPoints
      : (cache.polyPts || []);
    const polyPts = rawPolyPts.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    if (polyPts.length >= 3) {
      const loopPts = [...polyPts, polyPts[0]];
      const loopGeo = new THREE.BufferGeometry().setFromPoints(loopPts);
      const loopMat = new THREE.LineBasicMaterial({ color: 0x0284c7, depthTest: false });
      const loopLine = new THREE.Line(loopGeo, loopMat);
      loopLine.renderOrder = 997;
      surfaceQa3DGroup.add(loopLine);

      polyPts.forEach((p, idx) => {
        const pinColor = idx === 0 ? 0xff3b30 : 0x0284c7;
        if (typeof add3DPinMarker === "function") {
          add3DPinMarker(p, pinColor, surfaceQa3DGroup);
        } else {
          const sp = new THREE.Mesh(
            new THREE.SphereGeometry(idx === 0 ? 0.16 : 0.12, 12, 12),
            new THREE.MeshBasicMaterial({ color: pinColor, depthTest: false })
          );
          sp.position.copy(p);
          sp.renderOrder = 998;
          surfaceQa3DGroup.add(sp);
        }
      });
    }

    // 2. Oriented 3D Best-Fit Reference Plane Wireframe Grid
    const basisMat = new THREE.Matrix4().makeBasis(fu, fv, fn);
    const planeGeo = new THREE.PlaneGeometry(cache.spanU * 1.02, cache.spanV * 1.02, 8, 8);
    const planeMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      wireframe: true,
      transparent: true,
      opacity: 0.42,
      depthTest: false,
    });
    const planeMesh = new THREE.Mesh(planeGeo, planeMat);
    planeMesh.applyMatrix4(basisMat);
    planeMesh.position.copy(fc);
    planeMesh.renderOrder = 994;
    surfaceQa3DGroup.add(planeMesh);

    // 3. Protruding (> +T, Red/Orange), Intruding (< -T, Blue/Cyan) & Pass (Green) 3D Grid Elements
    const tolMm = Math.max(0.5, metrics.tolerance_mm || 3.0);
    const cells = cache.cells || [];
    const activeCells = cells.filter((c) => showPass3D || c.status === "high" || c.status === "low");
    const displayMode = QA_STATE.flatnessDisplayMode === "points" ? "points" : "tiles";

    if (activeCells.length > 0) {
      const cellGeom = displayMode === "points"
        ? new THREE.SphereGeometry(Math.min(cache.du, cache.dv) * 0.28, 12, 12)
        : new THREE.BoxGeometry(cache.du * 0.92, cache.dv * 0.92, 1.0);
      const instMat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: displayMode === "points" ? 0.96 : 0.94,
        depthTest: false,
      });
      const instMesh = new THREE.InstancedMesh(cellGeom, instMat, activeCells.length);
      instMesh.renderOrder = 996;

      const dummyMat = new THREE.Matrix4();
      const scaleMat = new THREE.Matrix4();
      const posVec = new THREE.Vector3();
      const col = new THREE.Color();

      for (let i = 0; i < activeCells.length; i++) {
        const c = activeCells[i];
        const absMm = Math.abs(c.devMm);
        const ratio = Math.min(3.5, absMm / tolMm);
        const sign = c.devM >= 0 ? 1.0 : -1.0;

        if (displayMode === "points") {
          const offsetM = Math.max(0.015, Math.min(0.14, Math.abs(c.devM) + 0.01));
          posVec.set(c.planeX, c.planeY, c.planeZ).addScaledVector(fn, sign * offsetM);
          dummyMat.identity();
          dummyMat.setPosition(posVec);
        } else {
          const prismThickM = Math.max(0.014, Math.min(0.14, Math.abs(c.devM) * 0.65 + 0.01));
          posVec.set(c.planeX, c.planeY, c.planeZ).addScaledVector(fn, sign * prismThickM * 0.5);
          dummyMat.copy(basisMat);
          scaleMat.makeScale(1.0, 1.0, prismThickM);
          dummyMat.multiply(scaleMat);
          dummyMat.setPosition(posVec);
        }
        instMesh.setMatrixAt(i, dummyMat);

        if (c.status === "high") {
          if (ratio >= 2.0) col.setHex(0xef4444);
          else col.setHex(0xf97316).lerp(new THREE.Color(0xef4444), (ratio - 1.0));
        } else if (c.status === "low") {
          if (ratio >= 2.0) col.setHex(0x2563eb);
          else col.setHex(0x06b6d4).lerp(new THREE.Color(0x2563eb), (ratio - 1.0));
        } else {
          col.setHex(0x10b981);
        }
        instMesh.setColorAt(i, col);
      }
      instMesh.instanceMatrix.needsUpdate = true;
      if (instMesh.instanceColor) instMesh.instanceColor.needsUpdate = true;
      surfaceQa3DGroup.add(instMesh);
    }

    if (window.studioThree.overlayGroup) {
      window.studioThree.overlayGroup.add(surfaceQa3DGroup);
    } else {
      window.studioThree.scene.add(surfaceQa3DGroup);
    }
    if (typeof updateZoomInvariantElements === "function") {
      updateZoomInvariantElements();
    }
    if (window.studioThree.renderer && window.studioThree.camera) {
      window.studioThree.renderer.render(window.studioThree.scene, window.studioThree.camera);
    }
  }

  function updateFlatnessRegulationBubbleUI(tolMm) {
    const spec = getFlatnessRegulationSpec(tolMm);
    const pillEl = document.getElementById("lblFlatnessSpecChapter");
    if (pillEl) pillEl.textContent = spec.code;
    const lnkEl = document.getElementById("lnkFlatnessRegPdf");
    if (lnkEl) {
      lnkEl.href = spec.url;
      lnkEl.title = t("點擊開啟政府施工綱要規範 PDF", "Click to open official government regulation PDF");
    }
    const txtEl = document.getElementById("lblFlatnessRegName");
    if (txtEl) {
      txtEl.textContent = t(spec.zh, spec.en);
    }
  }

  function openSurfaceFlatnessQaInspector() {
    if (typeof showSidePanel !== "function") return;
    if (typeof setActiveStudioTool === "function" && (!window.STATE || window.STATE.activeTool !== "flatness")) {
      setActiveStudioTool("flatness");
    }

    const curScanId = (window.STATE && window.STATE.activeScanId) || "scan";
    if (QA_STATE.flatnessCache && QA_STATE.flatnessCache.scanId && QA_STATE.flatnessCache.scanId !== curScanId) {
      QA_STATE.flatnessCache = null;
      QA_STATE.surfaceQaLastResult = null;
    }

    const tolMm = QA_STATE.flatnessToleranceMm || 3.0;
    const planeMode = QA_STATE.flatnessPlaneMode || "best_fit_3d";
    const volMode = QA_STATE.flatnessVolumeMode || "threshold";
    const dispMode = QA_STATE.flatnessDisplayMode || "tiles";
    const ptsCount = (window.STATE && Array.isArray(window.STATE.measurePoints)) ? window.STATE.measurePoints.length : 0;
    const isSampling = Boolean(QA_STATE.flatnessCancelToken && !QA_STATE.flatnessCancelToken.cancelled);
    const regSpec = getFlatnessRegulationSpec(tolMm);

    const html = `
      <div class="gs-qa-container" id="surfaceQaContainer">
        <!-- Header & Taiwan PCC Spec Pill -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:4px;">
          <span style="font-size:12px;font-weight:700;color:var(--ui-text-primary);display:inline-flex;align-items:center;gap:5px;">
            ${QA_SVGS.FLATNESS} ${t("區域平整度與補料分析", "Flatness & Material Takeoff")}
          </span>
          <span class="gcp-crs-pill" id="lblFlatnessSpecChapter">${regSpec.code}</span>
        </div>

        <!-- Step 1: 3D Polygon Drawing Guide & Controls -->
        <div class="gs-qa-card" id="flatnessStep1Card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <span style="font-size:11px;font-weight:700;color:var(--ui-text-primary);">
              1. ${t("檢測範圍 (可拖曳頂點微調)", "1. Inspection Polygon (Draggable)")}
            </span>
            <span id="badgeFlatnessPolyState" style="font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(2,132,199,0.15);color:#38bdf8;font-weight:700;">
              ${isSampling ? t("計算中...", "Sampling...") : QA_STATE.flatnessCache ? t("已鎖定", "Locked") : t("繪製中", "Drawing")}
            </span>
          </div>
          <div id="lblFlatnessVertexCount" style="font-size:10.5px;color:var(--ui-text-secondary);line-height:1.35;margin-bottom:6px;">
            ${
              QA_STATE.flatnessCache
                ? t(`已分析 ${QA_STATE.flatnessCache.totalAreaM2} m² — 可直接拖曳 3D 頂點或調整公差`, `Analyzed ${QA_STATE.flatnessCache.totalAreaM2} m² — drag 3D pins or adjust tolerance`)
                : isSampling
                ? t("網格取樣與平面擬合中...", "Sampling surface grid...")
                : ptsCount === 0
                ? t("點擊 3+ 點圍成範圍，點紅點 V1 或按 Enter 閉合", "Click 3+ pts on surface; click red V1 or Enter to close")
                : t(`已選 ${ptsCount} 點`, `${ptsCount} pts placed`)
            }
          </div>
          <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:5px;">
            <button type="button" class="btn-xs primary" id="btnLockFlatnessPoly" ${ptsCount >= 3 ? "" : "disabled"} title="${t("閉合多邊形並擬合基準面", "Close polygon and fit plane")}">
              ${QA_SVGS.CHECK} ${t("分析", "Analyze")}
            </button>
            <button type="button" class="btn-xs" id="btnUndoFlatnessVertex" ${ptsCount >= 1 ? "" : "disabled"} title="${t("復原上一點", "Undo last point")}">
              ${QA_SVGS.RESET} ${t("復原", "Undo")}
            </button>
            <button type="button" class="btn-xs" id="btnResetSurfaceQa" title="${t("清除並重繪範圍", "Clear and redraw polygon")}">
              ${QA_SVGS.PICK} ${t("重繪", "Redraw")}
            </button>
          </div>
          <!-- Background Time-Sliced Sampling Progress Bar -->
          <div id="flatnessSamplingProgressWrap" style="display:${isSampling ? "block" : "none"};margin-top:7px;">
            <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--ui-text-secondary);margin-bottom:3px;">
              <span id="lblFlatnessSamplingStage">${t("網格取樣與平面擬合中...", "Sampling surface grid...")}</span>
              <span id="lblFlatnessSamplingPct" style="font-weight:700;color:#38bdf8;">0%</span>
            </div>
            <div style="width:100%;height:5px;background:var(--ui-bg-subtle);border-radius:999px;overflow:hidden;">
              <div id="barFlatnessSamplingFill" style="width:0%;height:100%;background:linear-gradient(90deg,#0284c7,#22d3ee);transition:width 80ms linear;"></div>
            </div>
          </div>
        </div>

        <!-- Step 2: Reference Plane Mode -->
        <div class="gs-qa-card">
          <div style="font-size:11px;font-weight:700;color:var(--ui-text-secondary);margin-bottom:4px;">
            2. ${t("基準平面", "2. Reference Plane")}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;">
            <label class="gs-qa-mode-pill ${planeMode === "best_fit_3d" ? "active" : ""}">
              <input type="radio" name="qaRefMode" value="best_fit_3d" ${planeMode === "best_fit_3d" ? "checked" : ""} style="display:none;" />
              <span>${t("最佳擬合", "Best-Fit")}</span>
            </label>
            <label class="gs-qa-mode-pill ${planeMode === "horizontal" ? "active" : ""}">
              <input type="radio" name="qaRefMode" value="horizontal" ${planeMode === "horizontal" ? "checked" : ""} style="display:none;" />
              <span>${t("水平面", "Horizontal")}</span>
            </label>
            <label class="gs-qa-mode-pill ${planeMode === "vertical_plumb" ? "active" : ""}">
              <input type="radio" name="qaRefMode" value="vertical_plumb" ${planeMode === "vertical_plumb" ? "checked" : ""} style="display:none;" />
              <span>${t("鉛直面", "Plumb Wall")}</span>
            </label>
          </div>
        </div>

        <!-- Step 3: Taiwan PCC Regulation Presets, Clickable Regulation Bubble & Tolerance Slider -->
        <div class="gs-qa-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <span style="font-size:11px;font-weight:700;color:var(--ui-text-secondary);">
              3. ${t("公差門檻", "3. Tolerance")}
            </span>
            <span id="lblFlatnessTolReadout" style="font-size:12px;font-weight:800;color:#38bdf8;font-family:monospace;">
              +/-${tolMm.toFixed(1)} mm
            </span>
          </div>

          <!-- Taiwan PCC Specification Quick Presets -->
          <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:4px;margin-bottom:5px;">
            <button type="button" class="btn-xs ${Math.abs(tolMm - 3.0) < 0.1 ? "primary" : ""}" data-flatness-preset-mm="3.0" title="${t("第09611章 整體粉光地坪 (3m直規 ±3mm)", "Ch.09611 Monolithic Floor Troweling (±3mm)")}">
              ${t("±3mm 粉光", "±3mm Trowel")}
            </button>
            <button type="button" class="btn-xs ${Math.abs(tolMm - 6.0) < 0.1 ? "primary" : ""}" data-flatness-preset-mm="6.0" title="${t("第09220章 水泥砂漿一般粉刷 (3m直規 ±6mm)", "Ch.09220 Cement Mortar Plastering (±6mm)")}">
              ${t("±6mm 粉刷", "±6mm Plaster")}
            </button>
            <button type="button" class="btn-xs ${Math.abs(tolMm - 10.0) < 0.1 ? "primary" : ""}" data-flatness-preset-mm="10.0" title="${t("第03310章 結構用混凝土模板粗底 (±10mm)", "Ch.03310 Structural Concrete Formwork (±10mm)")}">
              ${t("±10mm 粗底", "±10mm Form")}
            </button>
            <button type="button" class="btn-xs ${Math.abs(tolMm - 15.0) < 0.1 ? "primary" : ""}" data-flatness-preset-mm="15.0" title="${t("第02742章 道路與廣場鋪面基層公差 (±15mm)", "Ch.02742 Road & Pavement Base (±15mm)")}">
              ${t("±15mm 鋪面", "±15mm Paving")}
            </button>
          </div>

          <!-- Clickable Government Regulation PDF Bubble -->
          <a id="lnkFlatnessRegPdf" href="${regSpec.url}" target="_blank" rel="noopener noreferrer"
             title="${t("點擊開啟政府施工綱要規範 PDF", "Click to open official government regulation PDF")}"
             style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:4px 8px;margin-bottom:6px;border-radius:6px;background:rgba(2,132,199,0.12);border:1px solid rgba(56,189,248,0.32);color:#38bdf8;font-size:10px;font-weight:600;text-decoration:none;transition:background 0.15s;">
            <span id="lblFlatnessRegName" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t(regSpec.zh, regSpec.en)}</span>
            <span style="flex-shrink:0;font-size:9.5px;padding:1px 5px;border-radius:4px;background:rgba(56,189,248,0.18);color:var(--ui-text-primary);font-weight:700;">PDF ↗</span>
          </a>

          <!-- Real-Time Slider + Numeric Input -->
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <input type="range" id="rngFlatnessToleranceMm" min="0.5" max="50" step="0.5" value="${tolMm}" style="flex:1;accent-color:#0284c7;cursor:pointer;" />
            <input type="number" id="qaToleranceMm" class="gs-input" value="${tolMm}" step="0.5" min="0.5" max="100" style="width:68px;height:26px;font-size:11px;text-align:right;" />
          </div>

          <!-- Volume Takeoff Baseline Mode (3 Options) & 3D Display Mode Toggle -->
          <div style="border-top:1px solid var(--ui-border);padding-top:6px;margin-top:4px;">
            <div style="font-size:10px;color:var(--ui-text-muted);margin-bottom:4px;">
              ${t("體積計算基準：", "Volume Calculation Baseline:")}
            </div>
            <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:4px;margin-bottom:6px;">
              <label class="gs-qa-mode-pill ${volMode === "threshold" ? "active" : ""}" title="${t("僅計算超出 ±公差門檻之體積 (|d| - T)", "Volume exceeding ±Tolerance (|d| - T)")}">
                <input type="radio" name="flatnessVolMode" value="threshold" ${volMode === "threshold" ? "checked" : ""} style="display:none;" />
                <span style="font-size:9.5px;">${t("超出公差", "Beyond ±Tol")}</span>
              </label>
              <label class="gs-qa-mode-pill ${volMode === "zero_plane" ? "active" : ""}" title="${t("超差區整平至 0mm 基準面之完整體積 (|d|)", "Full volume to level out-of-spec zones to 0mm plane")}">
                <input type="radio" name="flatnessVolMode" value="zero_plane" ${volMode === "zero_plane" ? "checked" : ""} style="display:none;" />
                <span style="font-size:9.5px;">${t("至 0mm 面", "To 0mm Plane")}</span>
              </label>
              <label class="gs-qa-mode-pill ${volMode === "fill_only" ? "active" : ""}" title="${t("不打磨高點，全區自平泥/砂漿填補至最高點所需體積", "No grinding; fill entire polygon up to highest peak")}">
                <input type="radio" name="flatnessVolMode" value="fill_only" ${volMode === "fill_only" ? "checked" : ""} style="display:none;" />
                <span style="font-size:9.5px;">${t("僅填至高點", "Fill Only")}</span>
              </label>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
              <label style="display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--ui-text-secondary);cursor:pointer;">
                <input type="checkbox" id="chkFlatnessShowPass3D" ${QA_STATE.flatnessShowPass3D ? "checked" : ""} />
                <span>${t("顯示合格格 (綠)", "Show Pass (Green)")}</span>
              </label>
              <div style="display:inline-flex;gap:3px;" role="group" aria-label="3D Display Mode">
                <button type="button" class="btn-xs ${dispMode === "tiles" ? "primary" : ""}" data-flatness-disp-mode="tiles" style="padding:2px 7px;font-size:10px;" title="${t("以規則網格色塊顯示", "Display as regular grid tiles")}">
                  ${t("色塊", "Tiles")}
                </button>
                <button type="button" class="btn-xs ${dispMode === "points" ? "primary" : ""}" data-flatness-disp-mode="points" style="padding:2px 7px;font-size:10px;" title="${t("以規則網格點顯示", "Display as regular grid points")}">
                  ${t("點雲", "Points")}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Export & Report Toolbar -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;">
          <button type="button" class="btn-xs" id="btnExportSurfaceQaCsv" title="${t("匯出格網偏差與體積 CSV", "Export Grid & Volume CSV")}">
            ${QA_SVGS.CSV} CSV
          </button>
          <button type="button" class="btn-xs primary" id="btnExportFlatnessReport" title="${t("產生含 3D 與正射截圖之檢驗報告", "Generate Engineering Report with Screenshots")}">
            ${QA_SVGS.PRINT} ${t("截圖報告", "Report")}
          </button>
        </div>

        <!-- Dynamic Results Card -->
        <div id="surfaceQaResultsCard" style="display:none;margin-top:8px;"></div>
      </div>
    `;

    showSidePanel(t("表面平整度", "Surface Flatness"), html);
    bindSurfaceQaEvents();

    if (QA_STATE.flatnessCache) {
      if (
        window.STATE &&
        (!Array.isArray(window.STATE.flatnessPolygonPoints) || window.STATE.flatnessPolygonPoints.length < 3) &&
        Array.isArray(QA_STATE.flatnessCache.polyPts) &&
        QA_STATE.flatnessCache.polyPts.length >= 3 &&
        window.THREE
      ) {
        window.STATE.flatnessPolygonPoints = QA_STATE.flatnessCache.polyPts.map(
          (p) => new window.THREE.Vector3(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0)
        );
        window.STATE.flatnessPolygonLocked = true;
        window.STATE.polygonLocked = true;
      }
      recomputeFlatnessMetricsAndVisuals();
    } else if (!isSampling) {
      refreshFlatnessDraftVisuals();
    }
  }

  function recomputeFlatnessMetricsAndVisuals() {
    const tolMm = Math.max(0.5, safeFloat(document.getElementById("qaToleranceMm")?.value, QA_STATE.flatnessToleranceMm || 3.0));
    QA_STATE.flatnessToleranceMm = tolMm;
    const volMode = document.querySelector('input[name="flatnessVolMode"]:checked')?.value || QA_STATE.flatnessVolumeMode || "threshold";
    QA_STATE.flatnessVolumeMode = volMode;
    const showPass = Boolean(document.getElementById("chkFlatnessShowPass3D")?.checked);
    QA_STATE.flatnessShowPass3D = showPass;

    const lblTol = document.getElementById("lblFlatnessTolReadout");
    if (lblTol) lblTol.textContent = `+/-${tolMm.toFixed(1)} mm`;

    updateFlatnessRegulationBubbleUI(tolMm);

    document.querySelectorAll("[data-flatness-preset-mm]").forEach((btn) => {
      const pVal = safeFloat(btn.getAttribute("data-flatness-preset-mm"), -1);
      btn.classList.toggle("primary", Math.abs(pVal - tolMm) < 0.08);
    });

    document.querySelectorAll("[data-flatness-disp-mode]").forEach((btn) => {
      const mVal = btn.getAttribute("data-flatness-disp-mode");
      btn.classList.toggle("primary", mVal === (QA_STATE.flatnessDisplayMode || "tiles"));
    });

    if (!QA_STATE.flatnessCache) return;
    const metrics = evaluateCachedFlatnessWithTolerance(QA_STATE.flatnessCache, tolMm, volMode);
    if (!metrics) return;
    QA_STATE.surfaceQaLastResult = metrics;
    renderSurfaceQaResults(metrics);
    renderPolygonFlatness3DOverlay(QA_STATE.flatnessCache, metrics, showPass);
  }

  async function lockFlatnessPolygonAndAnalyze(lockedPtsInput = null) {
    const rawPts = Array.isArray(lockedPtsInput) && lockedPtsInput.length >= 3
      ? lockedPtsInput
      : (window.STATE && Array.isArray(window.STATE.measurePoints) ? window.STATE.measurePoints.slice() : []);

    if (rawPts.length < 3) {
      if (typeof showToast === "function") {
        showToast(t("請先在 3D 表面點擊至少 3 個頂點", "Click at least 3 vertices on the 3D surface first"));
      }
      return;
    }

    if (window.studioThree && window.studioThree.polyPreviewGroup) {
      while (window.studioThree.polyPreviewGroup.children.length > 0) {
        window.studioThree.polyPreviewGroup.remove(window.studioThree.polyPreviewGroup.children[0]);
      }
    }

    const THREE = window.THREE;
    const polyPts = rawPts.map((p) =>
      typeof p.clone === "function"
        ? p.clone()
        : THREE
        ? new THREE.Vector3(Number(p.x), Number(p.y), Number(p.z))
        : { x: Number(p.x), y: Number(p.y), z: Number(p.z) }
    );
    if (window.STATE) {
      window.STATE.measurePoints = [];
      window.STATE.polygonLocked = true;
      window.STATE.flatnessPolygonLocked = true;
      window.STATE.flatnessPolygonPoints = polyPts;
    }

    const planeMode = document.querySelector('input[name="qaRefMode"]:checked')?.value || QA_STATE.flatnessPlaneMode || "best_fit_3d";
    QA_STATE.flatnessPlaneMode = planeMode;

    cancelActiveFlatnessJob();
    const cancelToken = { cancelled: false };
    QA_STATE.flatnessCancelToken = cancelToken;

    const progWrapInit = document.getElementById("flatnessSamplingProgressWrap");
    const badgeStateInit = document.getElementById("badgeFlatnessPolyState");
    if (progWrapInit) progWrapInit.style.display = "block";
    if (badgeStateInit) badgeStateInit.textContent = t("計算中...", "Sampling...");

    try {
      const cache = await computeClientFlatnessPolygonAsync(
        polyPts,
        planeMode,
        (pct) => {
          const progBar = document.getElementById("barFlatnessSamplingFill");
          const progPct = document.getElementById("lblFlatnessSamplingPct");
          if (progBar) progBar.style.width = `${pct}%`;
          if (progPct) progPct.textContent = `${pct}%`;
        },
        cancelToken
      );
      if (cancelToken.cancelled) return;
      QA_STATE.flatnessCancelToken = null;
      QA_STATE.flatnessCache = cache;
      const progWrap = document.getElementById("flatnessSamplingProgressWrap");
      const badgeState = document.getElementById("badgeFlatnessPolyState");
      if (progWrap) progWrap.style.display = "none";
      if (badgeState) badgeState.textContent = t("已鎖定", "Locked");
      const lblCount = document.getElementById("lblFlatnessVertexCount");
      if (lblCount) {
        lblCount.textContent = t(
          `已分析 ${cache.totalAreaM2} m² (${cache.cells.length} 格) — 可拖曳頂點或公差滑桿`,
          `Analyzed ${cache.totalAreaM2} m² (${cache.cells.length} cells) — drag pins or tolerance slider`
        );
      }
      recomputeFlatnessMetricsAndVisuals();
      if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
    } catch (err) {
      QA_STATE.flatnessCancelToken = null;
      if (err && err.message === "cancelled") return;
      console.error("[Flatness] Polygon sampling error:", err);
      const progWrap = document.getElementById("flatnessSamplingProgressWrap");
      if (progWrap) progWrap.style.display = "none";
    }
  }

  function bindSurfaceQaEvents() {
    document.querySelectorAll('input[name="qaRefMode"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        document.querySelectorAll('#surfaceQaContainer input[name="qaRefMode"]').forEach((r) => {
          r.closest(".gs-qa-mode-pill")?.classList.remove("active");
        });
        e.target.closest(".gs-qa-mode-pill")?.classList.add("active");
        QA_STATE.flatnessPlaneMode = e.target.value;
        const pts = (window.STATE && Array.isArray(window.STATE.flatnessPolygonPoints) && window.STATE.flatnessPolygonPoints.length >= 3)
          ? window.STATE.flatnessPolygonPoints
          : (QA_STATE.flatnessCache && Array.isArray(QA_STATE.flatnessCache.polyPts) ? QA_STATE.flatnessCache.polyPts : null);
        if (pts && pts.length >= 3) {
          lockFlatnessPolygonAndAnalyze(pts);
        }
      });
    });

    document.querySelectorAll('input[name="flatnessVolMode"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        document.querySelectorAll('#surfaceQaContainer input[name="flatnessVolMode"]').forEach((r) => {
          r.closest(".gs-qa-mode-pill")?.classList.remove("active");
        });
        e.target.closest(".gs-qa-mode-pill")?.classList.add("active");
        QA_STATE.flatnessVolumeMode = e.target.value;
        recomputeFlatnessMetricsAndVisuals();
      });
    });

    document.querySelectorAll("[data-flatness-disp-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-flatness-disp-mode") === "points" ? "points" : "tiles";
        QA_STATE.flatnessDisplayMode = mode;
        recomputeFlatnessMetricsAndVisuals();
      });
    });

    const rngTol = document.getElementById("rngFlatnessToleranceMm");
    const inpTol = document.getElementById("qaToleranceMm");

    rngTol?.addEventListener("input", (e) => {
      const val = Math.max(0.5, safeFloat(e.target.value, 3.0));
      if (inpTol) inpTol.value = String(val);
      recomputeFlatnessMetricsAndVisuals();
    });

    inpTol?.addEventListener("input", (e) => {
      const val = Math.max(0.5, safeFloat(e.target.value, 3.0));
      if (rngTol) rngTol.value = String(Math.min(50, val));
      recomputeFlatnessMetricsAndVisuals();
    });

    document.querySelectorAll("[data-flatness-preset-mm]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = Math.max(0.5, safeFloat(btn.getAttribute("data-flatness-preset-mm"), 3.0));
        if (inpTol) inpTol.value = String(val);
        if (rngTol) rngTol.value = String(Math.min(50, val));
        recomputeFlatnessMetricsAndVisuals();
      });
    });

    document.getElementById("chkFlatnessShowPass3D")?.addEventListener("change", () => {
      recomputeFlatnessMetricsAndVisuals();
    });

    document.getElementById("btnLockFlatnessPoly")?.addEventListener("click", () => {
      lockFlatnessPolygonAndAnalyze();
    });

    document.getElementById("btnUndoFlatnessVertex")?.addEventListener("click", () => {
      if (window.STATE && Array.isArray(window.STATE.measurePoints) && window.STATE.measurePoints.length > 0) {
        window.STATE.measurePoints.pop();
        refreshFlatnessDraftVisuals();
        if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
      }
    });

    document.getElementById("btnResetSurfaceQa")?.addEventListener("click", () => {
      cancelActiveFlatnessJob();
      QA_STATE.surfaceQaPoints = [];
      QA_STATE.surfaceQaWallLine = [];
      QA_STATE.surfaceQaLastResult = null;
      QA_STATE.flatnessCache = null;
      if (window.STATE) {
        window.STATE.measurePoints = [];
        window.STATE.polygonLocked = false;
        window.STATE.flatnessPolygonLocked = false;
        window.STATE.flatnessPolygonPoints = [];
        window.STATE.qaLinkedAreaMeasId = null;
      }
      if (window.studioThree && window.studioThree.polyPreviewGroup) {
        while (window.studioThree.polyPreviewGroup.children.length > 0) {
          window.studioThree.polyPreviewGroup.remove(window.studioThree.polyPreviewGroup.children[0]);
        }
      }
      surfaceQa3DGroup = clear3DGroup(surfaceQa3DGroup);
      const resEl = document.getElementById("surfaceQaResultsCard");
      if (resEl) resEl.style.display = "none";
      const badgeState = document.getElementById("badgeFlatnessPolyState");
      if (badgeState) badgeState.textContent = t("繪製中", "Drawing");
      refreshFlatnessDraftVisuals();
      if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
      if (typeof showToast === "function") {
        showToast(t("已清除多邊形，請重新框選", "Polygon cleared — click 3+ pts to redraw"));
      }
    });

    document.getElementById("btnExportSurfaceQaCsv")?.addEventListener("click", () => {
      if (!QA_STATE.surfaceQaLastResult || !QA_STATE.flatnessCache) {
        if (typeof showToast === "function") showToast(t("請先框選多邊形執行分析", "Draw and analyze a polygon first"));
        return;
      }
      exportSurfaceQaCsv(QA_STATE.surfaceQaLastResult, QA_STATE.flatnessCache);
    });

    document.getElementById("btnExportFlatnessReport")?.addEventListener("click", () => {
      if (!QA_STATE.surfaceQaLastResult || !QA_STATE.flatnessCache) {
        if (typeof showToast === "function") showToast(t("請先框選多邊形執行分析", "Draw and analyze a polygon first"));
        return;
      }
      exportFlatnessReportWithScreenshots(QA_STATE.surfaceQaLastResult, QA_STATE.flatnessCache);
    });
  }

  function renderSurfaceQaResults(res) {
    const card = document.getElementById("surfaceQaResultsCard");
    if (!card) return;
    card.style.display = "block";

    const passRate = res.pass_rate_pct !== undefined ? res.pass_rate_pct : 0.0;
    const badgeCls = passRate >= 85.0 ? "pass" : passRate >= 70.0 ? "warn" : "fail";
    const maxHigh = res.max_high || {};
    const maxLow = res.max_low || {};
    const astm = res.astm_e1155 || {};
    const plumb = res.plumb_tilt || {};
    const netL = res.net_volume_liters || 0;
    const isNetFill = netL >= 0;
    const isFillOnly = res.volume_mode === "fill_only";

    card.innerHTML = `
      <!-- Pass Rate & Area Summary Banner -->
      <div class="gs-qa-grade-box ${badgeCls}">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:10px;text-transform:uppercase;color:var(--ui-text-muted);">
              ${t("合格率", "Pass Rate")} (+/-${res.tolerance_mm} mm)
            </div>
            <div style="font-size:19px;font-weight:800;color:currentColor;">
              ${passRate}%
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:10.5px;font-weight:700;">
              ${t("面積", "Area")}: ${res.total_area_m2 || 0} m²
            </div>
            <div style="font-size:10px;color:var(--ui-text-muted);">
              ${res.pass_count || 0}/${res.total_points || 0} ${t("格", "cells")} · RMS ${res.rms_dev_mm || 0} mm
            </div>
          </div>
        </div>
      </div>

      <!-- Protruding (Excess) vs Intruding (Lacking) Takeoff Cards -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:6px;">
        <div class="gs-qa-stat-pill" style="border-left:3px solid #ef4444;padding-left:7px;">
          <div style="font-size:10px;font-weight:700;color:#ef4444;">
            ${t("凸起 (> +公差，打磨)", "High (> +Tol, Grind)")}
          </div>
          <div style="font-size:13px;font-weight:800;color:#ef4444;margin-top:2px;">
            ${res.excess_volume_liters} L <span style="font-size:10px;font-weight:600;color:var(--ui-text-secondary);">(${res.excess_volume_m3} m³)</span>
          </div>
          <div style="font-size:9.5px;color:var(--ui-text-secondary);margin-top:2px;">
            ${t("面積", "Area")}: <b>${res.high_area_m2} m²</b> (${res.high_area_pct}%)
          </div>
          <div style="font-size:9.5px;color:var(--ui-text-muted);font-family:monospace;">
            ${t("最高", "Max")}: +${maxHigh.dev_mm || 0} mm
          </div>
        </div>

        <div class="gs-qa-stat-pill" style="border-left:3px solid #3b82f6;padding-left:7px;">
          <div style="font-size:10px;font-weight:700;color:#3b82f6;">
            ${isFillOnly ? t("全區填至最高點", "Fill to Max Peak") : t("凹陷 (< -公差，填補)", "Low (< -Tol, Fill)")}
          </div>
          <div style="font-size:13px;font-weight:800;color:#3b82f6;margin-top:2px;">
            ${res.lacking_volume_liters} L <span style="font-size:10px;font-weight:600;color:var(--ui-text-secondary);">(${res.lacking_volume_m3} m³)</span>
          </div>
          <div style="font-size:9.5px;color:var(--ui-text-secondary);margin-top:2px;">
            ${t("面積", "Area")}: <b>${res.low_area_m2} m²</b> (${res.low_area_pct}%)
          </div>
          <div style="font-size:9.5px;color:var(--ui-text-muted);font-family:monospace;">
            ${t("最低", "Min")}: ${maxLow.dev_mm || 0} mm
          </div>
        </div>
      </div>

      <!-- Net Material Takeoff & 25kg Mortar Bag Estimate -->
      <div class="gs-qa-card" style="margin-top:6px;background:rgba(2,132,199,0.08);border-color:rgba(56,189,248,0.28);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
          <span style="font-size:10.5px;font-weight:700;color:var(--ui-text-primary);">
            ${isFillOnly ? t("總填補量 (至最高點)", "Total Fill (To Peak)") : t("淨材料差額 (填-磨)", "Net Material (Fill-Grind)")}:
          </span>
          <span style="font-size:12px;font-weight:800;color:${isNetFill ? "#38bdf8" : "#f97316"};">
            ${isNetFill ? t("需補料", "Net Fill") : t("需打磨", "Net Grind")} ${Math.abs(netL).toFixed(2)} L (${Math.abs(res.net_volume_m3 || 0).toFixed(4)} m³)
          </span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--ui-text-secondary);">
          <span>${t("預估 25kg 砂漿/自平泥 (13.5 L/包):", "Est. 25kg Mortar (13.5 L/bag):")}</span>
          <b style="color:var(--ui-text-primary);">${res.est_mortar_bags_25kg || 0} ${t("包", "bags")}</b>
        </div>
      </div>

      <!-- Plane Geometry, ASTM E1155 & Plumb Tilt Details -->
      <div class="gs-qa-card" style="margin-top:6px;">
        <div style="display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:3px;">
          <span style="color:var(--ui-text-muted);">${t("表面型態 / 坡度", "Surface / Slope")}:</span>
          <span style="font-weight:700;color:var(--ui-text-primary);">${t(plumb.surface_class_zh || "平面", plumb.surface_class_en || "Plane")} · ${plumb.slope_deg || 0}° (${plumb.tilt_ratio || "1:INF"})</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:3px;">
          <span style="color:var(--ui-text-muted);">ASTM E1155 (F_F / F_L):</span>
          <span style="font-weight:700;color:var(--ui-text-primary);">F_F ${astm.ff_flatness || "—"} / F_L ${astm.fl_levelness || "—"}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10.5px;">
          <span style="color:var(--ui-text-muted);">${t("傾角 / 方位", "Plumb / Azimuth")}:</span>
          <span style="font-weight:700;color:var(--ui-text-primary);">${plumb.plumb_mm_per_m || 0} mm/m · ${plumb.azimuth_deg || 0}°</span>
        </div>
      </div>
    `;
  }

  function exportSurfaceQaCsv(res, cache) {
    const pts = (cache && Array.isArray(cache.cells)) ? cache.cells : [];
    const lines = [
      `# GatheringScans Polygon-Based 3D Surface Flatness & Material Takeoff Report`,
      `# Scan ID: ${res.scan_id} | CRS: EPSG:3826+TWVD2001`,
      `# Reference Mode: ${res.reference_mode} | Tolerance: +/-${res.tolerance_mm}mm | Volume Baseline: ${res.volume_mode}`,
      `# Area: ${res.total_area_m2} m2 | Pass Rate: ${res.pass_rate_pct}% (${res.pass_count}/${res.total_points}) | RMS: ${res.rms_dev_mm}mm`,
      `# Excess (> +Tol): ${res.excess_volume_liters} L (${res.excess_volume_m3} m3) | Lacking (< -Tol): ${res.lacking_volume_liters} L (${res.lacking_volume_m3} m3) | Net Fill: ${res.net_volume_liters} L`,
      `Index,Easting,Northing,Elevation,Deviation_mm,CellArea_m2,Status`,
    ];
    pts.forEach((p, i) => {
      lines.push(`${i + 1},${p.e},${p.n},${p.h},${Number(p.devMm || 0).toFixed(2)},${Number(cache.cellAreaM2 || 0).toFixed(4)},${String(p.status || "pass").toUpperCase()}`);
    });
    downloadBlob("\uFEFF" + lines.join("\r\n"), `flatness_takeoff_${res.scan_id || "scan"}.csv`, "text/csv;charset=utf-8;");
  }

  /**
   * Captures 2 high-resolution screenshots (1: 3D Perspective View, 2: Plane-Normal Top-Down
   * Orthographic Deviation Map with HUD legend & V1..Vn labels) and opens a printable A4 HTML Report.
   */
  function exportFlatnessReportWithScreenshots(res, cache) {
    if (!window.studioThree || !window.studioThree.renderer || !window.studioThree.scene || !window.studioThree.camera) {
      if (typeof showToast === "function") showToast(t("3D 視圖尚未就緒", "3D viewport not ready"));
      return;
    }
    const { renderer, scene, camera, controls } = window.studioThree;
    const THREE = window.THREE;

    // 1. Capture Figure 1: Current 3D Perspective View
    renderer.render(scene, camera);
    const fig1DataUrl = renderer.domElement.toDataURL("image/png");

    // 2. Capture Figure 2: Plane-Normal Top-Down / Elevation View with HUD Legend & Vertex Labels
    const savedPos = camera.position.clone();
    const savedQuat = camera.quaternion.clone();
    const savedUp = camera.up.clone();
    const savedTarget = controls ? controls.target.clone() : new THREE.Vector3();

    const p = cache.plane;
    const fc = new THREE.Vector3(p.center.x, p.center.y, p.center.z);
    const fn = new THREE.Vector3(p.normal.x, p.normal.y, p.normal.z).normalize();
    const fv = new THREE.Vector3(p.vAxis.x, p.vAxis.y, p.vAxis.z).normalize();
    const maxSpan = Math.max(cache.spanU || 4, cache.spanV || 4, 3.0);
    const camDist = maxSpan * 1.45;

    camera.position.copy(fc).addScaledVector(fn, camDist);
    camera.up.copy(fv);
    camera.lookAt(fc);
    camera.updateMatrixWorld(true);
    renderer.render(scene, camera);

    // Composite WebGL canvas + 2D vector annotations (V1..Vn labels + color legend)
    const srcCvs = renderer.domElement;
    const outCvs = document.createElement("canvas");
    outCvs.width = srcCvs.width;
    outCvs.height = srcCvs.height;
    const ctx = outCvs.getContext("2d");
    ctx.drawImage(srcCvs, 0, 0);

    // Project V1..Vn onto Figure 2 canvas
    if (Array.isArray(cache.polyPts)) {
      ctx.font = "bold 14px Inter, sans-serif";
      cache.polyPts.forEach((pt, idx) => {
        const v = new THREE.Vector3(pt.x, pt.y, pt.z).project(camera);
        const sx = (v.x * 0.5 + 0.5) * outCvs.width;
        const sy = (-v.y * 0.5 + 0.5) * outCvs.height;
        ctx.fillStyle = idx === 0 ? "#ef4444" : "#0284c7";
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(`V${idx + 1}`, sx + 9, sy + 4);
      });
    }

    // Draw Legend Box on Figure 2
    ctx.fillStyle = "rgba(15, 23, 42, 0.86)";
    ctx.fillRect(18, 18, 280, 92);
    ctx.strokeStyle = "rgba(56, 189, 248, 0.5)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(18, 18, 280, 92);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 13px sans-serif";
    ctx.fillText(`平面正射高低差分佈圖 (公差 +/-${res.tolerance_mm} mm)`, 30, 40);
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(30, 52, 14, 14);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "12px sans-serif";
    ctx.fillText(`凸起超差 (> +${res.tolerance_mm}mm): ${res.excess_volume_liters} L (${res.high_area_m2} m²)`, 52, 63);
    ctx.fillStyle = "#3b82f6";
    ctx.fillRect(30, 74, 14, 14);
    ctx.fillStyle = "#f8fafc";
    ctx.fillText(`凹陷超差 (< -${res.tolerance_mm}mm): ${res.lacking_volume_liters} L (${res.low_area_m2} m²)`, 52, 85);
    const fig2DataUrl = outCvs.toDataURL("image/png");

    // Restore camera immediately
    camera.position.copy(savedPos);
    camera.quaternion.copy(savedQuat);
    camera.up.copy(savedUp);
    if (controls) {
      controls.target.copy(savedTarget);
      controls.update();
    }
    renderer.render(scene, camera);

    const nowStr = new Date().toISOString().slice(0, 19).replace("T", " ");
    const netL = res.net_volume_liters || 0;
    const reportHtml = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <title>3D 表面平整度與補料打磨體積檢驗報告 - ${res.scan_id}</title>
  <style>
    body { font-family: "Microsoft JhengHei", "Noto Sans TC", sans-serif; color: #0f172a; margin: 24px; line-height: 1.5; }
    h1 { font-size: 20px; margin: 0 0 4px 0; color: #0f172a; border-bottom: 2px solid #0284c7; padding-bottom: 8px; }
    .meta { font-size: 12px; color: #475569; margin-bottom: 14px; display: flex; justify-content: space-between; }
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
    .kpi-box { border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px 12px; background: #f8fafc; }
    .kpi-label { font-size: 11px; color: #64748b; }
    .kpi-val { font-size: 18px; font-weight: 800; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 12.5px; }
    th, td { border: 1px solid #cbd5e1; padding: 7px 10px; text-align: left; }
    th { background: #f1f5f9; font-weight: 700; }
    .figs { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 18px; }
    .fig-card { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px; background: #fff; }
    .fig-card img { width: 100%; height: auto; border-radius: 4px; display: block; }
    .fig-cap { font-size: 11.5px; font-weight: 700; color: #334155; margin-top: 6px; text-align: center; }
    .sign-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 24px; }
    .sign-box { border: 1px solid #94a3b8; border-radius: 6px; padding: 10px 12px; height: 64px; font-size: 12px; color: #334155; }
    @media print { .no-print { display: none; } body { margin: 10mm; } }
  </style>
</head>
<body>
  <div class="no-print" style="margin-bottom:12px;text-align:right;">
    <button onclick="window.print()" style="padding:6px 14px;background:#0284c7;color:#fff;border:none;border-radius:4px;font-weight:700;cursor:pointer;">列印 / 另存 PDF (Print)</button>
  </div>
  <h1>3D 掃描多邊形區域平整度與補料/打磨體積檢驗報告</h1>
  <div class="meta">
    <span>掃描專案編號：<b>${res.scan_id}</b> ｜ 座標系統：<b>EPSG:3826 (TWD97) + TWVD2001</b></span>
    <span>檢驗時間：<b>${nowStr}</b> ｜ 依據規範：<b>行政院公共工程委員會 施工綱要規範 第09611/09220/03310章</b></span>
  </div>

  <div class="kpi-grid">
    <div class="kpi-box">
      <div class="kpi-label">合格公差門檻 / 合格率</div>
      <div class="kpi-val" style="color:#0284c7;">+/-${res.tolerance_mm} mm (${res.pass_rate_pct}%)</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">凸起超差體積 (需打磨剔除)</div>
      <div class="kpi-val" style="color:#dc2626;">${res.excess_volume_liters} L (${res.excess_volume_m3} m³)</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">凹陷超差體積 (需填補批土)</div>
      <div class="kpi-val" style="color:#2563eb;">${res.lacking_volume_liters} L (${res.lacking_volume_m3} m³)</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">淨材料差額 ｜ 凹陷填補 25kg 砂漿</div>
      <div class="kpi-val" style="color:#0f172a;font-size:15.5px;">${netL >= 0 ? "淨補 " : "淨磨 "}${Math.abs(netL).toFixed(2)} L ｜ 填補 ${res.est_mortar_bags_25kg} 包</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>檢驗項目</th>
        <th>面積 (m² / 比例)</th>
        <th>極值偏差 (mm)</th>
        <th>體積 (公升 L)</th>
        <th>體積 (立方公尺 m³)</th>
        <th>施工處置建議</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><b>凸起超差區域 (&gt; +${res.tolerance_mm} mm)</b></td>
        <td>${res.high_area_m2} m² (${res.high_area_pct}%)</td>
        <td style="color:#dc2626;font-weight:700;">+${res.max_high?.dev_mm || 0} mm</td>
        <td><b>${res.excess_volume_liters} L</b></td>
        <td>${res.excess_volume_m3} m³</td>
        <td>局部高點研磨機打磨或剔除</td>
      </tr>
      <tr>
        <td><b>凹陷超差區域 (&lt; -${res.tolerance_mm} mm)</b></td>
        <td>${res.low_area_m2} m² (${res.low_area_pct}%)</td>
        <td style="color:#2563eb;font-weight:700;">${res.max_low?.dev_mm || 0} mm</td>
        <td><b>${res.lacking_volume_liters} L</b></td>
        <td>${res.lacking_volume_m3} m³</td>
        <td>水泥砂漿 / 環氧樹脂砂漿 / 自平泥填補 (約 ${res.est_mortar_bags_25kg} 包 25kg)</td>
      </tr>
      <tr>
        <td><b>合格範圍內 (|偏差| &le; ${res.tolerance_mm} mm)</b></td>
        <td>${Number(Math.max(0, (res.total_area_m2 || 0) - (res.high_area_m2 || 0) - (res.low_area_m2 || 0))).toFixed(2)} m² (${res.pass_rate_pct}%)</td>
        <td>RMS ${res.rms_dev_mm} mm</td>
        <td>0.00 L</td>
        <td>0.0000 m³</td>
        <td>符合公共工程施工綱要規範容許公差</td>
      </tr>
    </tbody>
  </table>

  <div class="figs">
    <div class="fig-card">
      <img src="${fig1DataUrl}" alt="3D Perspective View" />
      <div class="fig-cap">圖 1：3D 視角最佳擬合基準面與凸起(紅)/凹陷(藍)區域分佈圖</div>
    </div>
    <div class="fig-card">
      <img src="${fig2DataUrl}" alt="Orthographic Deviation Map" />
      <div class="fig-cap">圖 2：基準面法線正射投影偏差分佈圖 (含頂點 V1..Vn 與色階圖例)</div>
    </div>
  </div>

  <div class="sign-grid">
    <div class="sign-box">測量與 3D 掃描工程師簽章：</div>
    <div class="sign-box">現場品管工程師 (QC) 簽章：</div>
    <div class="sign-box">監造單位查驗簽章：</div>
  </div>
</body>
</html>`;

    QA_STATE.lastReportHtml = reportHtml;
    const win = window.open("", "_blank");
    if (win && win.document) {
      win.document.open();
      win.document.write(reportHtml);
      win.document.close();
    } else {
      downloadBlob(reportHtml, `flatness_qa_report_${res.scan_id || "scan"}.html`, "text/html;charset=utf-8;");
    }
    return reportHtml;
  }

  // =========================================================================
  // 2. OPEN-TRENCH UTILITY 3D TRACER
  // =========================================================================

  function openUtilityTracerInspector() {
    if (typeof showSidePanel !== "function") return;
    if (typeof setActiveStudioTool === "function" && (!window.STATE || window.STATE.activeTool !== "trench")) {
      setActiveStudioTool("trench");
    }
    const scanId = (window.STATE && window.STATE.activeScanId) || "";

    const html = `
      <div class="gs-qa-container" id="utilityTracerContainer">
        <!-- Compact Header & CRS Pill -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:12px;font-weight:700;color:var(--ui-text-primary);">
            ${QA_SVGS.PIPE} ${t("明挖管溝 3D 竣工實測", "Open-Trench Utility 3D Tracer")}
          </span>
          <span class="gcp-crs-pill">EPSG:3826 + TWVD2001</span>
        </div>

        <!-- Pipe Parameters Card -->
        <div class="gs-qa-card">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <div>
              <label style="font-size:10.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("管線類別", "Utility Type")}
              </label>
              <select id="selUtilPipeType" class="gs-select" style="width:100%;">
                <option value="DRAIN">${t("雨排 (Cyan)", "Storm Drain")}</option>
                <option value="SEWER">${t("污水 (Amber)", "Sewer")}</option>
                <option value="WATER">${t("自來水 (Blue)", "Water Supply")}</option>
                <option value="GAS">${t("瓦斯 (Yellow)", "Gas")}</option>
                <option value="ELEC">${t("電力 (Red)", "Electric")}</option>
                <option value="TELECOM">${t("電信 (Green)", "Telecom")}</option>
              </select>
            </div>
            <div>
              <label style="font-size:10.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("管徑 (mm)", "Diameter (mm)")}
              </label>
              <select id="selUtilPipeDia" class="gs-select" style="width:100%;">
                <option value="150">150 mm</option>
                <option value="200">200 mm</option>
                <option value="300" selected>300 mm</option>
                <option value="400">400 mm</option>
                <option value="600">600 mm</option>
                <option value="1000">1000 mm</option>
              </select>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;">
            <div>
              <label style="font-size:10.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("量測點基準", "Point Mode")}
              </label>
              <select id="selUtilPointMode" class="gs-select" style="width:100%;">
                <option value="invert" selected>${t("管底 (Invert)", "Invert")}</option>
                <option value="crown">${t("管頂 (Crown)", "Crown")}</option>
                <option value="ground">${t("地表 (Ground)", "Ground")}</option>
              </select>
            </div>
            <div>
              <label style="font-size:10.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("規定覆土深 (m)", "Min Cover (m)")}
              </label>
              <input type="number" id="inpUtilMinCover" class="gs-input" value="1.20" step="0.1" />
            </div>
          </div>
        </div>

        <!-- 1-Word Action Button Toolbar -->
        <div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:4px;margin-top:4px;">
          <button type="button" class="btn-xs primary" id="btnTraceUtility" title="${t("計算管溝高程與坡度", "Trace Pipe")}">
            ${QA_SVGS.PIPE} ${t("追蹤", "Trace")}
          </button>
          <button type="button" class="btn-xs" id="btnPickUtilityPoint" title="${t("在 3D 模型拾取管溝點", "Add Point")}">
            ${QA_SVGS.PICK} ${t("加點", "Pick")}
          </button>
          <button type="button" class="btn-xs" id="btnClearUtilityTrace" title="${t("清除點位與 3D 模型", "Clear")}">
            ${QA_SVGS.RESET} ${t("清除", "Clear")}
          </button>
          <button type="button" class="btn-xs" id="btnExportUtilityCsv" title="${t("導出管溝檢核 CSV", "Export CSV")}">
            ${QA_SVGS.CSV} CSV
          </button>
          <button type="button" class="btn-xs" id="btnExportUtilityDxf" title="${t("導出 3D AutoCAD DXF", "Export DXF")}">
            ${QA_SVGS.DXF} DXF
          </button>
        </div>

        <!-- Dynamic Results / Empty-State Guidance Card -->
        <div id="utilityTracerResultsCard" style="display:block;margin-top:8px;">
          <div class="gs-qa-card" style="border:1px dashed rgba(20,184,166,0.38);background:rgba(20,184,166,0.06);">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
              <span style="font-size:10.5px;font-weight:700;color:#14b8a6;">${t("自建 / 竣工實測獨立圖層", "Isolated User As-Built Layer")}</span>
              <span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:999px;background:rgba(20,184,166,0.16);color:#14b8a6;border:1px solid rgba(20,184,166,0.38);">NON-API</span>
            </div>
            <div style="font-size:10.5px;color:var(--ui-text-muted);line-height:1.45;">
              ${t("請點擊「加點」於 3D 管溝連續拾取至少 2 個管底/人孔點位，再點擊「追蹤」計算坡度與覆土深（嚴格與官方 API 圖層隔離）。", "Click 'Pick' to sample at least 2 trench invert/manhole points in 3D, then click 'Trace' to compute slope & cover depth (strictly isolated from Official API layers).")}
            </div>
          </div>
        </div>
      </div>
    `;

    showSidePanel(t("管溝竣工實測", "Utility Tracer"), html);
    bindUtilityTracerEvents(scanId);
    if (Array.isArray(QA_STATE.utilityTrenchPoints) && QA_STATE.utilityTrenchPoints.length >= 2) {
      runUtilityTrace(scanId);
    }
  }

  function bindUtilityTracerEvents(scanId) {
    document.getElementById("btnTraceUtility")?.addEventListener("click", () => {
      runUtilityTrace(scanId);
    });

    document.getElementById("btnPickUtilityPoint")?.addEventListener("click", () => {
      QA_STATE.isPickingUtilityPoint = true;
      if (typeof showToast === "function") {
        showToast(t("請在 3D 視圖中連續點擊管溝管底或人孔", "Click on 3D trench to add invert points"));
      }
    });

    document.getElementById("btnClearUtilityTrace")?.addEventListener("click", () => {
      QA_STATE.utilityTrenchPoints = [];
      QA_STATE.utilityLastResult = null;
      utilityTrace3DGroup = clear3DGroup(utilityTrace3DGroup);
      if (typeof window.clearUserTracedUtilityFromGisLayer === "function") {
        window.clearUserTracedUtilityFromGisLayer(scanId || (window.STATE && window.STATE.activeScanId) || "");
      }
      const resEl = document.getElementById("utilityTracerResultsCard");
      if (resEl) {
        resEl.style.display = "block";
        resEl.innerHTML = `
          <div class="gs-qa-card" style="border:1px dashed rgba(20,184,166,0.38);background:rgba(20,184,166,0.06);">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
              <span style="font-size:10.5px;font-weight:700;color:#14b8a6;">${t("自建 / 竣工實測獨立圖層", "Isolated User As-Built Layer")}</span>
              <span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:999px;background:rgba(20,184,166,0.16);color:#14b8a6;border:1px solid rgba(20,184,166,0.38);">NON-API</span>
            </div>
            <div style="font-size:10.5px;color:var(--ui-text-muted);line-height:1.45;">
              ${t("請點擊「加點」於 3D 管溝連續拾取至少 2 個管底/人孔點位，再點擊「追蹤」計算坡度與覆土深（嚴格與官方 API 圖層隔離）。", "Click 'Pick' to sample at least 2 trench invert/manhole points in 3D, then click 'Trace' to compute slope & cover depth (strictly isolated from Official API layers).")}
            </div>
          </div>
        `;
      }
      if (typeof showToast === "function") showToast(t("已清除管溝點位", "Utility Points Cleared"));
    });

    document.getElementById("btnExportUtilityCsv")?.addEventListener("click", () => {
      if (!QA_STATE.utilityLastResult) {
        if (typeof showToast === "function") showToast(t("請先執行管溝追蹤", "Run utility trace first"));
        return;
      }
      downloadBlob(
        QA_STATE.utilityLastResult.csv_export || "",
        `utility_trace_${QA_STATE.utilityLastResult.scan_id || "scan"}.csv`,
        "text/csv;charset=utf-8;"
      );
    });

    document.getElementById("btnExportUtilityDxf")?.addEventListener("click", () => {
      if (!QA_STATE.utilityLastResult) {
        if (typeof showToast === "function") showToast(t("請先執行管溝追蹤", "Run utility trace first"));
        return;
      }
      downloadBlob(
        QA_STATE.utilityLastResult.dxf_export || "",
        `utility_trace_${QA_STATE.utilityLastResult.scan_id || "scan"}.dxf`,
        "application/dxf;charset=utf-8;"
      );
    });
  }

  async function runUtilityTrace(scanId) {
    const pipeType = document.getElementById("selUtilPipeType")?.value || "DRAIN";
    const pipeDia = safeFloat(document.getElementById("selUtilPipeDia")?.value, 300.0);
    const ptMode = document.getElementById("selUtilPointMode")?.value || "invert";
    const minCov = safeFloat(document.getElementById("inpUtilMinCover")?.value, 1.20);

    const payload = {
      scan_id: scanId || (window.STATE && window.STATE.activeScanId) || "",
      pipe_type: pipeType,
      pipe_diameter_mm: pipeDia,
      point_mode: ptMode,
      min_cover_m: minCov,
      trench_points: QA_STATE.utilityTrenchPoints.length > 0 ? QA_STATE.utilityTrenchPoints : null,
    };

    try {
      const res = typeof apiPost === "function" ? await apiPost("/api/survey/utility-trace", payload) : null;
      if (!res || res.status !== "ok") {
        if (typeof showToast === "function") showToast(t("管溝追蹤計算失敗", "Utility trace calculation failed"));
        return;
      }
      QA_STATE.utilityLastResult = res;
      renderUtilityTraceResults(res);
      renderUtilityTrace3DOverlay(res);
      if (
        Array.isArray(res.stations) &&
        res.stations.length >= 2 &&
        typeof window.syncUserTracedUtilityToGisLayer === "function"
      ) {
        window.syncUserTracedUtilityToGisLayer(res, payload.scan_id);
        if (typeof showToast === "function") {
          showToast(t("已完成管溝追蹤並同步至自建管線圖層", "Utility pipe traced & synced to User As-Built layer"));
        }
      }
    } catch (err) {
      console.error("[UtilityTracer] Error:", err);
      if (typeof showToast === "function") showToast(t("連線伺服器異常", "Network error"));
    }
  }

  function renderUtilityTraceResults(res) {
    const card = document.getElementById("utilityTracerResultsCard");
    if (!card) return;
    card.style.display = "block";

    const stations = res.stations || [];
    let tableRows = "";
    stations.forEach((s) => {
      const covCls = s.cover_pass ? "color:#10b981;font-weight:700;" : "color:#ef4444;font-weight:700;";
      tableRows += `
        <tr>
          <td style="font-weight:700;">${s.station_label}</td>
          <td>${s.name}</td>
          <td style="text-align:right;">${s.invert_z}m</td>
          <td style="text-align:right;">${s.crown_z}m</td>
          <td style="text-align:right;${covCls}">${s.cover_depth_m}m</td>
          <td style="text-align:right;">${s.slope_ratio}</td>
        </tr>
      `;
    });

    card.innerHTML = `
      <div class="gs-qa-card">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
          <div>
            <div style="font-size:10px;color:var(--ui-text-muted);">${t("總長度 (2D / 3D)", "Length (2D/3D)")}</div>
            <div style="font-size:12px;font-weight:800;color:var(--ui-text-primary);">
              ${res.total_length_2d_m || 0}m / ${res.total_length_3d_m || 0}m
            </div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--ui-text-muted);">${t("總體坡度", "Overall Slope")}</div>
            <div style="font-size:12px;font-weight:800;color:var(--ui-text-primary);">
              ${res.overall_slope_ratio || "—"} (${res.overall_slope_pct || 0}%)
            </div>
          </div>
        </div>
      </div>

      <!-- Station Table -->
      <div style="max-height:160px;overflow-y:auto;border:1px solid var(--ui-border);border-radius:6px;margin-top:6px;">
        <table class="gs-qa-table" style="width:100%;font-size:10px;">
          <thead>
            <tr>
              <th>${t("樁號", "Station")}</th>
              <th>${t("點號", "Pt")}</th>
              <th style="text-align:right;">${t("管底", "Invert")}</th>
              <th style="text-align:right;">${t("管頂", "Crown")}</th>
              <th style="text-align:right;">${t("覆土", "Cover")}</th>
              <th style="text-align:right;">${t("坡度", "Slope")}</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderUtilityTrace3DOverlay(res) {
    if (!window.studioThree || !window.studioThree.scene || !window.THREE) return;
    utilityTrace3DGroup = clear3DGroup(utilityTrace3DGroup);
    utilityTrace3DGroup = new window.THREE.Group();
    utilityTrace3DGroup.name = "GS_UtilityTrace_Overlay";

    const originTwd = (typeof localToTwd97 === "function") ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };
    const stations = res.stations || [];
    const dia = Math.max(0.2, res.pipe_diameter_m || 0.3);

    if (stations.length >= 2) {
      const invPoints = [];
      const crownPoints = [];
      const groundPoints = [];

      for (let i = 0; i < stations.length; i++) {
        const s = stations[i];
        const lx = Number(s.e) - originTwd.e;
        const ly_inv = Number(s.invert_z) - originTwd.h;
        const ly_crown = Number(s.crown_z !== undefined ? s.crown_z : s.invert_z + dia) - originTwd.h;
        const ly_ground = Number(s.ground_z !== undefined ? s.ground_z : ly_crown + (s.cover_depth_m || 1.2)) - originTwd.h;
        const lz = originTwd.n - Number(s.n);

        const vInv = new window.THREE.Vector3(lx, ly_inv, lz);
        const vCrown = new window.THREE.Vector3(lx, ly_crown, lz);
        const vGround = new window.THREE.Vector3(lx, ly_ground, lz);

        invPoints.push(vInv);
        crownPoints.push(vCrown);
        groundPoints.push(vGround);

        // Vertical depth-of-cover drop lines from ground down to pipe crown
        const dropGeo = new window.THREE.BufferGeometry().setFromPoints([vGround, vCrown]);
        const dropMat = new window.THREE.LineBasicMaterial({ color: 0x10b981, depthTest: false });
        const dropLine = new window.THREE.Line(dropGeo, dropMat);
        dropLine.renderOrder = 997;
        utilityTrace3DGroup.add(dropLine);

        // Floating station marker disk / ring
        const ringGeo = new window.THREE.RingGeometry(dia * 0.6, dia * 0.9, 16);
        ringGeo.rotateX(-Math.PI / 2);
        const ringMat = new window.THREE.MeshBasicMaterial({ color: 0xf59e0b, side: window.THREE.DoubleSide, depthTest: false });
        const ringMesh = new window.THREE.Mesh(ringGeo, ringMat);
        ringMesh.position.copy(vGround);
        ringMesh.renderOrder = 998;
        utilityTrace3DGroup.add(ringMesh);
      }

      // True 3D Cylindrical Pipe segments
      const pipeMat = new window.THREE.MeshStandardMaterial({
        color: 0x06b6d4,
        emissive: 0x06b6d4,
        emissiveIntensity: 0.5,
        roughness: 0.3,
        metalness: 0.2,
        transparent: true,
        opacity: 0.92,
        depthTest: false,
      });

      for (let i = 0; i < invPoints.length - 1; i++) {
        const v1 = invPoints[i];
        const v2 = invPoints[i + 1];
        const segDist = v1.distanceTo(v2);
        if (segDist < 0.02) continue;

        const cylGeo = new window.THREE.CylinderGeometry(dia * 0.5, dia * 0.5, segDist, 16);
        const mid = new window.THREE.Vector3().addVectors(v1, v2).multiplyScalar(0.5);
        const dir = new window.THREE.Vector3().subVectors(v2, v1).normalize();

        const cylMesh = new window.THREE.Mesh(cylGeo, pipeMat);
        cylMesh.position.copy(mid);
        cylMesh.quaternion.setFromUnitVectors(new window.THREE.Vector3(0, 1, 0), dir);
        cylMesh.renderOrder = 996;
        utilityTrace3DGroup.add(cylMesh);

        // Trench wireframe corridor
        const trenchWidth = Math.max(1.0, dia * 2.5);
        const trenchGeo = new window.THREE.BoxGeometry(trenchWidth, dia * 1.5, segDist);
        const trenchMat = new window.THREE.MeshBasicMaterial({
          color: 0xf59e0b,
          wireframe: true,
          transparent: true,
          opacity: 0.45,
          depthTest: false,
        });
        const trenchMesh = new window.THREE.Mesh(trenchGeo, trenchMat);
        trenchMesh.position.copy(mid);
        trenchMesh.quaternion.setFromUnitVectors(new window.THREE.Vector3(0, 0, 1), dir);
        trenchMesh.renderOrder = 995;
        utilityTrace3DGroup.add(trenchMesh);
      }

      // Auto-frame camera on trench
      if (invPoints.length > 0 && window.studioThree.camera && window.studioThree.controls) {
        const midIdx = Math.floor(invPoints.length / 2);
        const center = invPoints[midIdx];
        const totalLen = res.total_length_3d_m || 20;
        const camDist = Math.max(15, totalLen * 0.8);
        window.studioThree.controls.target.copy(center);
        window.studioThree.camera.position.set(center.x + camDist * 0.7, center.y + camDist * 0.65, center.z + camDist * 0.7);
        window.studioThree.controls.update();
      }
    }

    if (window.studioThree.overlayGroup) {
      window.studioThree.overlayGroup.add(utilityTrace3DGroup);
    } else {
      window.studioThree.scene.add(utilityTrace3DGroup);
    }

    if (window.studioThree.renderer && window.studioThree.camera) {
      window.studioThree.renderer.render(window.studioThree.scene, window.studioThree.camera);
    }
  }

  // =========================================================================
  // 3. COMPARE VIEW ΔV VOLUME TAKEOFF
  // =========================================================================

  function openCompareVolumeTakeoffInspector() {
    if (typeof showSidePanel !== "function") return;
    if (typeof setActiveStudioTool === "function" && (!window.STATE || window.STATE.activeTool !== "compare_volume")) {
      setActiveStudioTool("compare_volume");
    }
    const baseId = (window.STATE && window.STATE.compareBaseScanId) || (window.STATE && window.STATE.activeScanId) || "";
    const compId = (window.STATE && window.STATE.compareScanId) || baseId;

    const html = `
      <div class="gs-qa-container" id="compareVolumeContainer">
        <!-- Compact Header & CRS Pill -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:12px;font-weight:700;color:var(--ui-text-primary);">
            ${QA_SVGS.COMPARE} ${t("多時期比對 ΔV 土方計算", "Compare View ΔV Volume")}
          </span>
          <span class="gcp-crs-pill">EPSG:3826 + TWVD2001</span>
        </div>

        <!-- Scan Epoches Selector -->
        <div class="gs-qa-card">
          <div style="font-size:10.5px;color:var(--ui-text-muted);margin-bottom:2px;">
            ${t("基期 (Epoch 1) vs 比對期 (Epoch 2)", "Baseline vs Compare Epoch")}
          </div>
          <div style="font-size:11px;font-weight:700;color:var(--ui-text-primary);">
            ${baseId || "Baseline"} &nbsp;&rarr;&nbsp; ${compId || "Compare"}
          </div>

        </div>

        <!-- Material Parameters -->
        <div class="gs-qa-card">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <div>
              <label style="font-size:10.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("土壤土質", "Material")}
              </label>
              <select id="selCmpSoilMaterial" class="gs-select" style="width:100%;">
                <option value="common_earth" selected>${t("普通土 (Common Earth)", "Common Earth")}</option>
                <option value="crushed_rock">${t("碎石級配 (Crushed Rock)", "Crushed Rock")}</option>
                <option value="clay">${t("黏土 (Clay)", "Clay")}</option>
                <option value="sand">${t("砂土 (Sand)", "Sand")}</option>
              </select>
            </div>
            <div>
              <label style="font-size:10.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("卡車容量 (m³)", "Truck (m³)")}
              </label>
              <input type="number" id="inpCmpTruckCap" class="gs-input" value="12" step="1" />
            </div>
          </div>
        </div>

        <!-- 1-Word Action Button Toolbar -->
        <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:4px;margin-top:4px;">
          <button type="button" class="btn-xs primary" id="btnRunCompareVolume" title="${t("計算時期差體積", "Compute")}">
            ${QA_SVGS.CALC} ${t("計算", "Compute")}
          </button>
          <button type="button" class="btn-xs" id="btnPickComparePoly" title="${t("在 3D 模型繪製多邊形範圍", "Polygon")}">
            ${QA_SVGS.PICK} ${t("圈選", "Polygon")}
          </button>
          <button type="button" class="btn-xs" id="btnExportCompareCsv" title="${t("導出體積報表", "Export CSV")}">
            ${QA_SVGS.CSV} ${t("導出", "CSV")}
          </button>
        </div>

        <!-- Dynamic Results Card -->
        <div id="compareVolumeResultsCard" style="display:none;margin-top:8px;">
          <!-- Populated by renderCompareVolumeResults -->
        </div>
      </div>
    `;

    showSidePanel(t("時期差體積計算", "Compare Volume"), html);
    bindCompareVolumeEvents(baseId, compId);
    runCompareVolumeTakeoff(baseId, compId);
  }

  function bindCompareVolumeEvents(baseId, compId) {
    document.getElementById("btnRunCompareVolume")?.addEventListener("click", () => {
      runCompareVolumeTakeoff(baseId, compId);
    });

    document.getElementById("btnPickComparePoly")?.addEventListener("click", () => {
      QA_STATE.isPickingComparePoly = true;
      QA_STATE.comparePolyDraft = [];
      if (typeof showToast === "function") {
        showToast(t("請在 3D 模型表面點擊至少 3 處頂點圈選比較範圍", "Click 3+ vertices on 3D surface to bound compare region"));
      }
    });

    document.getElementById("btnExportCompareCsv")?.addEventListener("click", () => {
      const r = QA_STATE.compareVolumeLastResult;
      if (!r) {
        if (typeof showToast === "function") showToast(t("請先計算時期差體積", "Run compare volume first"));
        return;
      }
      const bal = r.site_balance || {};
      const lines = [
        "\uFEFFBaseline_Scan,Compare_Scan,Cut_BCM_m3,Fill_CCM_m3,Net_DeltaV_m3,Cut_Mass_t,Fill_Mass_t,Haul_Trips,Limiting_Constraint",
        `"${r.baseline_scan_id || baseId}","${r.compare_scan_id || compId}",${r.cut_volume_bcm || 0},${r.fill_volume_ccm || 0},${r.net_volume_delta_m3 || 0},${r.cut_mass_tonnes || 0},${r.fill_mass_tonnes || 0},${bal.truck_trips || 0},"${bal.limiting_constraint || ""}"`,
      ];
      downloadBlob(lines.join("\r\n"), `compare_volume_${r.baseline_scan_id || "scan"}.csv`, "text/csv;charset=utf-8;");
    });
  }

  async function runCompareVolumeTakeoff(baseId, compId) {
    const matType = document.getElementById("selCmpSoilMaterial")?.value || "common_earth";
    const truckCap = safeFloat(document.getElementById("inpCmpTruckCap")?.value, 12.0);

    const payload = {
      baseline_scan_id: baseId,
      compare_scan_id: compId,
      material_type: matType,
      truck_capacity_m3: truckCap,
      polygon:
        (Array.isArray(QA_STATE.comparePolyDraft) && QA_STATE.comparePolyDraft.length >= 3
          ? QA_STATE.comparePolyDraft
          : null) ||
        (window.STATE && window.STATE.activeVolumePolygon) ||
        null,
    };

    try {
      const res = typeof apiPost === "function" ? await apiPost("/api/survey/compare-volume", payload) : null;
      if (!res || res.status !== "ok") {
        if (typeof showToast === "function") showToast(t("時期差體積計算失敗", "Compare volume failed"));
        return;
      }
      QA_STATE.compareVolumeLastResult = res;
      renderCompareVolumeResults(res);
      renderCompareVolume3DOverlay(res);
    } catch (err) {
      console.error("[CompareVolume] Error:", err);
      if (typeof showToast === "function") showToast(t("網路連線異常", "Network error"));
    }
  }

  function renderCompareVolume3DOverlay(res) {
    if (!window.studioThree || !window.studioThree.scene || !window.THREE) return;
    compareVolume3DGroup = clear3DGroup(compareVolume3DGroup);
    compareVolume3DGroup = new window.THREE.Group();
    compareVolume3DGroup.name = "GS_CompareVolume_Overlay";

    const originTwd = (typeof localToTwd97 === "function") ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };
    const cells = res.heatmap_cells || [];

    const cutMat = new window.THREE.MeshStandardMaterial({
      color: 0xef4444,
      emissive: 0xef4444,
      emissiveIntensity: 0.5,
      roughness: 0.3,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });
    const fillMat = new window.THREE.MeshStandardMaterial({
      color: 0x3b82f6,
      emissive: 0x3b82f6,
      emissiveIntensity: 0.5,
      roughness: 0.3,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });

    const minPt = new window.THREE.Vector3(Infinity, Infinity, Infinity);
    const maxPt = new window.THREE.Vector3(-Infinity, -Infinity, -Infinity);

    cells.forEach((cell) => {
      const lx = Number(cell.e) - originTwd.e;
      const ly_b = Number(cell.z_base) - originTwd.h;
      const ly_c = Number(cell.z_comp) - originTwd.h;
      const lz = originTwd.n - Number(cell.n);
      const dz = Number(cell.delta_z || (ly_c - ly_b));

      const h = Math.max(0.15, Math.min(6.0, Math.abs(dz)));
      const prismGeo = new window.THREE.BoxGeometry(0.85, h, 0.85);
      const isCut = dz < 0;
      const prism = new window.THREE.Mesh(prismGeo, isCut ? cutMat : fillMat);
      const midY = (ly_b + ly_c) * 0.5;
      prism.position.set(lx, midY, lz);
      prism.renderOrder = 996;
      compareVolume3DGroup.add(prism);

      minPt.x = Math.min(minPt.x, lx);
      minPt.y = Math.min(minPt.y, midY);
      minPt.z = Math.min(minPt.z, lz);
      maxPt.x = Math.max(maxPt.x, lx);
      maxPt.y = Math.max(maxPt.y, midY);
      maxPt.z = Math.max(maxPt.z, lz);
    });

    if (window.studioThree.overlayGroup) {
      window.studioThree.overlayGroup.add(compareVolume3DGroup);
    } else {
      window.studioThree.scene.add(compareVolume3DGroup);
    }

    // Auto-frame camera on compare volume region
    if (cells.length > 0 && window.studioThree.camera && window.studioThree.controls) {
      const center = new window.THREE.Vector3().addVectors(minPt, maxPt).multiplyScalar(0.5);
      const span = Math.max(maxPt.x - minPt.x, maxPt.z - minPt.z, 15);
      window.studioThree.controls.target.copy(center);
      window.studioThree.camera.position.set(center.x + span * 0.85, center.y + span * 0.7, center.z + span * 0.85);
      window.studioThree.controls.update();
    }

    if (window.studioThree.renderer && window.studioThree.camera) {
      window.studioThree.renderer.render(window.studioThree.scene, window.studioThree.camera);
    }
  }

  function renderCompareVolumeResults(res) {
    const card = document.getElementById("compareVolumeResultsCard");
    if (!card) return;
    card.style.display = "block";

    const bal = res.site_balance || {};
    card.innerHTML = `
      <div class="gs-qa-grade-box pass">
        <div style="font-size:10px;text-transform:uppercase;color:var(--ui-text-muted);">
          ${t("淨土方差 (ΔV)", "Net Volume (ΔV)")}
        </div>
        <div style="font-size:18px;font-weight:800;color:currentColor;">
          ${res.net_volume_delta_m3 > 0 ? "+" : ""}${res.net_volume_delta_m3 || 0} m³
        </div>
        <div style="font-size:10.5px;font-weight:700;margin-top:2px;">
          ${bal.type || "—"}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:6px;">
        <div class="gs-qa-stat-pill">
          <div style="font-size:9.5px;color:var(--ui-text-muted);">${t("挖方 (BCM)", "Cut (BCM)")}</div>
          <div style="font-size:12px;font-weight:800;color:#ef4444;">
            ${res.cut_volume_bcm || 0} m³
          </div>
          <div style="font-size:9px;color:var(--ui-text-muted);">${res.cut_mass_tonnes || 0} t</div>
        </div>
        <div class="gs-qa-stat-pill">
          <div style="font-size:9.5px;color:var(--ui-text-muted);">${t("填方 (CCM)", "Fill (CCM)")}</div>
          <div style="font-size:12px;font-weight:800;color:#3b82f6;">
            ${res.fill_volume_ccm || 0} m³
          </div>
          <div style="font-size:9px;color:var(--ui-text-muted);">${res.fill_mass_tonnes || 0} t</div>
        </div>
      </div>

      <div class="gs-qa-card" style="margin-top:6px;">
        <div style="display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:3px;">
          <span style="color:var(--ui-text-muted);">${t("預估卡車車次", "Haul Trips")}:</span>
          <span style="font-weight:700;color:var(--ui-text-primary);">${bal.truck_trips || 0} ${t("車次", "trips")}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10.5px;">
          <span style="color:var(--ui-text-muted);">${t("拘束限制條件", "Limiting Constraint")}:</span>
          <span style="font-weight:700;color:var(--ui-text-primary);">${bal.limiting_constraint || "—"}</span>
        </div>
      </div>
    `;
  }

  // =========================================================================
  // 4. RTK STAKEOUT EXPORT STRICTLY IN E, N, Z ORDER
  // =========================================================================

  function openRtkStakeoutInspector() {
    if (typeof showSidePanel !== "function") return;
    if (typeof setActiveStudioTool === "function" && (!window.STATE || window.STATE.activeTool !== "stakeout")) {
      setActiveStudioTool("stakeout");
    }
    const scanId = (window.STATE && window.STATE.activeScanId) || "";

    const html = `
      <div class="gs-qa-container" id="rtkStakeoutContainer">
        <!-- Compact Header & Mandatory E, N, Z Coordinate Pill -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:12px;font-weight:700;color:var(--ui-text-primary);">
            ${QA_SVGS.STAKEOUT} ${t("RTK 工地放樣導出", "RTK Stakeout Export")}
          </span>
          <span class="gcp-crs-pill" style="color:#059669;border-color:rgba(16,185,129,0.4);">
            PtID, E, N, Z, Code
          </span>
        </div>

        <!-- Mode Selector -->
        <div class="gs-qa-card">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
            <label class="gs-qa-mode-pill active">
              <input type="radio" name="stkSourceMode" value="custom" checked style="display:none;" />
              <span>${t("自選點位", "Custom Points")}</span>
            </label>
            <label class="gs-qa-mode-pill">
              <input type="radio" name="stkSourceMode" value="grid" style="display:none;" />
              <span>${t("基礎網格", "Grid Array")}</span>
            </label>
          </div>
        </div>

        <!-- 1-Word Action Button Toolbar -->
        <div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:4px;margin-top:4px;">
          <button type="button" class="btn-xs primary" id="btnGenStakeout" title="${t("生成放樣點位", "Generate")}">
            ${QA_SVGS.STAKEOUT} ${t("放樣", "Stake")}
          </button>
          <button type="button" class="btn-xs" id="btnPickStakeoutPt" title="${t("在 3D 視圖中拾取放樣點", "Pick Pt")}">
            ${QA_SVGS.PICK} ${t("加點", "Pick")}
          </button>
          <button type="button" class="btn-xs" id="btnExportStakeoutCsv" title="${t("導出標準 CSV (嚴格 E N Z 順序)", "CSV")}">
            ${QA_SVGS.CSV} CSV
          </button>
          <button type="button" class="btn-xs" id="btnExportStakeoutTxt" title="${t("導出 Leica/Trimble TXT", "TXT")}">
            ${QA_SVGS.PIPE} TXT
          </button>
          <button type="button" class="btn-xs" id="btnPrintStakeoutSheet" title="${t("列印 A4 現場放樣檢核記錄表", "Print")}">
            ${QA_SVGS.PRINT} ${t("列印", "Print")}
          </button>
        </div>

        <!-- Point List Preview Card -->
        <div id="stakeoutPointsCard" style="margin-top:8px;">
          <!-- Populated by renderStakeoutPointsTable -->
        </div>
      </div>
    `;

    showSidePanel(t("RTK 放樣導出", "RTK Stakeout"), html);
    bindRtkStakeoutEvents(scanId);
    runGenerateStakeout(scanId);
  }

  function bindRtkStakeoutEvents(scanId) {
    document.querySelectorAll('input[name="stkSourceMode"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        document.querySelectorAll("#rtkStakeoutContainer .gs-qa-mode-pill").forEach((p) => p.classList.remove("active"));
        e.target.closest(".gs-qa-mode-pill")?.classList.add("active");
        if (e.target.value === "grid") {
          QA_STATE.stakeoutPoints = [];
        }
        runGenerateStakeout(scanId);
      });
    });

    document.getElementById("btnGenStakeout")?.addEventListener("click", () => {
      runGenerateStakeout(scanId);
    });

    document.getElementById("btnPickStakeoutPt")?.addEventListener("click", () => {
      QA_STATE.isPickingStakeoutPoint = true;
      if (typeof showToast === "function") {
        showToast(t("請在 3D 視圖中點擊放置放樣點", "Click on 3D view to add stakeout point"));
      }
    });

    document.getElementById("btnExportStakeoutCsv")?.addEventListener("click", () => {
      if (!QA_STATE.stakeoutLastResult) return;
      downloadBlob(
        QA_STATE.stakeoutLastResult.csv_export || "",
        `stakeout_ENZ_${QA_STATE.stakeoutLastResult.scan_id || "site"}.csv`,
        "text/csv;charset=utf-8;"
      );
    });

    document.getElementById("btnExportStakeoutTxt")?.addEventListener("click", () => {
      if (!QA_STATE.stakeoutLastResult) return;
      downloadBlob(
        QA_STATE.stakeoutLastResult.txt_export || "",
        `stakeout_rover_${QA_STATE.stakeoutLastResult.scan_id || "site"}.txt`,
        "text/plain;charset=utf-8;"
      );
    });

    document.getElementById("btnPrintStakeoutSheet")?.addEventListener("click", () => {
      if (!QA_STATE.stakeoutLastResult || !QA_STATE.stakeoutLastResult.html_field_sheet) return;
      const win = window.open("", "_blank");
      if (win) {
        win.document.write(QA_STATE.stakeoutLastResult.html_field_sheet);
        win.document.close();
        win.focus();
        setTimeout(() => win.print(), 350);
      }
    });
  }

  async function runGenerateStakeout(scanId) {
    const srcMode = document.querySelector('input[name="stkSourceMode"]:checked')?.value || "custom";
    const payload = {
      scan_id: scanId || (window.STATE && window.STATE.activeScanId) || "",
      source_mode: srcMode,
      points: QA_STATE.stakeoutPoints.length > 0 ? QA_STATE.stakeoutPoints : null,
    };

    try {
      const res = typeof apiPost === "function" ? await apiPost("/api/survey/stakeout-export", payload) : null;
      if (!res || res.status !== "ok") return;
      QA_STATE.stakeoutLastResult = res;
      renderStakeoutPointsTable(res);
      renderStakeout3DOverlay(res);
    } catch (err) {
      console.error("[RTKStakeout] Error:", err);
    }
  }

  function renderStakeoutPointsTable(res) {
    const card = document.getElementById("stakeoutPointsCard");
    if (!card) return;

    const pts = res.points || [];
    let rows = "";
    pts.forEach((p) => {
      rows += `
        <tr>
          <td style="font-weight:700;">${p.ptid}</td>
          <td style="font-family:monospace;text-align:right;">${p.easting.toFixed(3)}</td>
          <td style="font-family:monospace;text-align:right;">${p.northing.toFixed(3)}</td>
          <td style="font-family:monospace;text-align:right;">${p.elevation.toFixed(3)}</td>
          <td>${p.code}</td>
        </tr>
      `;
    });

    card.innerHTML = `
      <div style="max-height:200px;overflow-y:auto;border:1px solid var(--ui-border);border-radius:6px;">
        <table class="gs-qa-table" style="width:100%;font-size:10px;">
          <thead>
            <tr>
              <th>PtID</th>
              <th style="text-align:right;">Easting (m)</th>
              <th style="text-align:right;">Northing (m)</th>
              <th style="text-align:right;">Elev (m)</th>
              <th>Code</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderStakeout3DOverlay(res) {
    if (!window.studioThree || !window.studioThree.scene || !window.THREE) return;
    stakeout3DGroup = clear3DGroup(stakeout3DGroup);
    stakeout3DGroup = new window.THREE.Group();
    stakeout3DGroup.name = "GS_Stakeout_Overlay";

    const pts = res.points || [];
    const originTwd = (typeof localToTwd97 === "function") ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 };

    const pinGeom = new window.THREE.ConeGeometry(0.22, 0.7, 12);
    pinGeom.rotateX(Math.PI);
    const pinMat = new window.THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xf59e0b,
      emissiveIntensity: 0.6,
      roughness: 0.25,
      depthTest: false,
    });

    const minPt = new window.THREE.Vector3(Infinity, Infinity, Infinity);
    const maxPt = new window.THREE.Vector3(-Infinity, -Infinity, -Infinity);

    pts.forEach((p) => {
      const e = p.e !== undefined ? p.e : p.easting;
      const n = p.n !== undefined ? p.n : p.northing;
      const h = p.h !== undefined ? p.h : p.elevation;
      const lx = Number(e) - originTwd.e;
      const ly = Number(h) - originTwd.h;
      const lz = originTwd.n - Number(n);

      const pin = new window.THREE.Mesh(pinGeom, pinMat);
      pin.position.set(lx, ly + 0.45, lz);
      pin.renderOrder = 997;
      stakeout3DGroup.add(pin);

      // Vertical drop line to surface
      const dropGeo = new window.THREE.BufferGeometry().setFromPoints([
        new window.THREE.Vector3(lx, ly, lz),
        new window.THREE.Vector3(lx, ly + 1.2, lz),
      ]);
      const dropMat = new window.THREE.LineBasicMaterial({ color: 0xf59e0b, depthTest: false });
      const dropLine = new window.THREE.Line(dropGeo, dropMat);
      dropLine.renderOrder = 997;
      stakeout3DGroup.add(dropLine);

      minPt.x = Math.min(minPt.x, lx);
      minPt.y = Math.min(minPt.y, ly);
      minPt.z = Math.min(minPt.z, lz);
      maxPt.x = Math.max(maxPt.x, lx);
      maxPt.y = Math.max(maxPt.y, ly);
      maxPt.z = Math.max(maxPt.z, lz);
    });

    if (window.studioThree.overlayGroup) {
      window.studioThree.overlayGroup.add(stakeout3DGroup);
    } else {
      window.studioThree.scene.add(stakeout3DGroup);
    }

    if (pts.length > 0 && window.studioThree.camera && window.studioThree.controls) {
      const center = new window.THREE.Vector3().addVectors(minPt, maxPt).multiplyScalar(0.5);
      const span = Math.max(maxPt.x - minPt.x, maxPt.z - minPt.z, 12);
      window.studioThree.controls.target.copy(center);
      window.studioThree.camera.position.set(center.x + span * 0.85, center.y + span * 0.7, center.z + span * 0.85);
      window.studioThree.controls.update();
    }

    if (window.studioThree.renderer && window.studioThree.camera) {
      window.studioThree.renderer.render(window.studioThree.scene, window.studioThree.camera);
    }
  }

  // Blob download utility
  function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  function syncQaLinkedPolygonEdit(source, action, idx, pt = null, measId = null) {
    const st = window.STATE;
    if (!st) return;
    const linkedId = st.qaLinkedAreaMeasId;
    const isLinked =
      Boolean(linkedId) &&
      (source === "flatnessPolygonPoints" ||
        source === "drainagePolygonPoints" ||
        (source === "completed" && measId === linkedId));

    if (isLinked) {
      const areaMeas = (st.completedMeasurements || []).find(
        (m) => m && m.id === linkedId && m.type === "area" && Array.isArray(m.points)
      );
      const targets = [];
      if (source !== "completed" && areaMeas) targets.push(areaMeas.points);
      if (source !== "flatnessPolygonPoints" && Array.isArray(st.flatnessPolygonPoints) && st.flatnessPolygonPoints.length >= 3) {
        targets.push(st.flatnessPolygonPoints);
      }
      if (source !== "drainagePolygonPoints" && Array.isArray(st.drainagePolygonPoints) && st.drainagePolygonPoints.length >= 3) {
        targets.push(st.drainagePolygonPoints);
      }
      for (const arr of targets) {
        if (action === "move" && pt && arr[idx] && typeof arr[idx].copy === "function") {
          arr[idx].copy(pt);
        } else if (action === "insert" && pt && Number.isFinite(idx)) {
          arr.splice(idx, 0, typeof pt.clone === "function" ? pt.clone() : pt);
        } else if (action === "delete" && Number.isFinite(idx) && arr.length > 3) {
          arr.splice(idx, 1);
        }
      }
    }

    if (action === "commit") {
      if (
        (source === "drainagePolygonPoints" || (isLinked && st.activeTool === "drainage")) &&
        Array.isArray(st.drainagePolygonPoints) &&
        st.drainagePolygonPoints.length >= 3 &&
        typeof window.renderDrainageAndSlopeVisuals3D === "function"
      ) {
        window.renderDrainageAndSlopeVisuals3D();
      }
      if (
        isLinked &&
        source !== "flatnessPolygonPoints" &&
        st.activeTool === "flatness" &&
        Array.isArray(st.flatnessPolygonPoints) &&
        st.flatnessPolygonPoints.length >= 3
      ) {
        lockFlatnessPolygonAndAnalyze(st.flatnessPolygonPoints);
      }
    }
  }

  // Global exports & API bindings
  window.syncQaLinkedPolygonEdit = syncQaLinkedPolygonEdit;
  window.openSurfaceFlatnessQaInspector = openSurfaceFlatnessQaInspector;
  window.lockFlatnessPolygonAndAnalyze = lockFlatnessPolygonAndAnalyze;
  window.refreshFlatnessDraftVisuals = refreshFlatnessDraftVisuals;
  window.recomputeFlatnessMetricsAndVisuals = recomputeFlatnessMetricsAndVisuals;
  window.renderPolygonFlatness3DOverlay = renderPolygonFlatness3DOverlay;
  window.fitFlatnessReferencePlane = fitFlatnessReferencePlane;
  window.computeClientFlatnessPolygonAsync = computeClientFlatnessPolygonAsync;
  window.exportFlatnessReportWithScreenshots = exportFlatnessReportWithScreenshots;
  window.openUtilityTracerInspector = openUtilityTracerInspector;
  window.openCompareVolumeTakeoffInspector = openCompareVolumeTakeoffInspector;
  window.openRtkStakeoutInspector = openRtkStakeoutInspector;
  window.onQaPanelsClosed = onQaPanelsClosed;
  window.QA_STATE = QA_STATE;

  window.handleQaTool3DCanvasPick = function (tool, pt, twd, isNearStartVertex) {
    if (!twd) return false;
    const scanId = (window.STATE && window.STATE.activeScanId) || "";
    if (QA_STATE.isPickingComparePoly) {
      if (!Array.isArray(QA_STATE.comparePolyDraft)) QA_STATE.comparePolyDraft = [];
      QA_STATE.comparePolyDraft.push({ e: Number(twd.e.toFixed(3)), n: Number(twd.n.toFixed(3)) });
      if (QA_STATE.comparePolyDraft.length >= 3) {
        const baseId = (window.STATE && window.STATE.compareBaseScanId) || scanId;
        const compId = (window.STATE && window.STATE.compareScanId) || baseId;
        runCompareVolumeTakeoff(baseId, compId);
      } else if (typeof showToast === "function") {
        showToast(t(`已選取頂點 #${QA_STATE.comparePolyDraft.length} — 滿 3 點自動計算`, `Vertex #${QA_STATE.comparePolyDraft.length} placed`));
      }
      return true;
    }
    if ((tool === "stationing" || (window.STATE && window.STATE.isPickingStationAlignment)) && typeof window.handleStationAlignment3DPick === "function") {
      return window.handleStationAlignment3DPick(pt, twd);
    }
    if (tool === "flatness" || QA_STATE.isPickingFlatnessPoint) {
      if (!window.STATE || !pt) return true;
      if (!Array.isArray(window.STATE.measurePoints)) window.STATE.measurePoints = [];
      if (window.STATE.flatnessPolygonLocked && window.STATE.measurePoints.length === 0) {
        if (typeof showToast === "function") {
          showToast(t("檢測多邊形已鎖定 — 如需重新框選請點擊面板「重繪範圍」按鈕", "Flatness polygon is locked — click 'Redraw' in the side panel to draw a new polygon"));
        }
        return true;
      }
      const startPt = window.STATE.measurePoints[0];
      const closedOnStart =
        window.STATE.measurePoints.length >= 3 &&
        startPt &&
        (typeof isNearStartVertex === "function"
          ? isNearStartVertex(pt, startPt)
          : isNearStartVertex === true ||
            (typeof pt.distanceTo === "function" && pt.distanceTo(startPt) < 0.65));
      if (closedOnStart) {
        lockFlatnessPolygonAndAnalyze(window.STATE.measurePoints.slice());
        return true;
      }
      window.STATE.polygonLocked = false;
      window.STATE.flatnessPolygonLocked = false;
      window.STATE.measurePoints.push(typeof pt.clone === "function" ? pt.clone() : pt);
      refreshFlatnessDraftVisuals();
      if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
      const cnt = window.STATE.measurePoints.length;
      if (typeof showToast === "function") {
        if (cnt < 3) {
          showToast(t(`平整度頂點 V${cnt} 已標記 — 再點 ${3 - cnt} 點可形成範圍`, `Flatness vertex V${cnt} placed — click ${3 - cnt} more`));
        } else {
          showToast(t(`已標記 ${cnt} 個頂點 — 點擊紅色起點 V1 或按 Enter 閉合分析`, `${cnt} vertices placed — click red V1 or press Enter to analyze`));
        }
      }
      return true;
    }
    if (tool === "trench" || QA_STATE.isPickingUtilityPoint) {
      const depthCover = safeFloat(document.getElementById("inpUtilMinCover")?.value, 1.2);
      QA_STATE.utilityTrenchPoints.push({
        e: Number(twd.e.toFixed(3)),
        n: Number(twd.n.toFixed(3)),
        h: Number((twd.h - depthCover).toFixed(3)),
        ground_h: Number(twd.h.toFixed(3)),
      });
      if (QA_STATE.utilityTrenchPoints.length >= 2) {
        runUtilityTrace(scanId);
      } else if (typeof showToast === "function") {
        showToast(t("已設定管溝起點 — 請點擊下一處管溝節點", "Trench Pt #1 placed — click next trench vertex"));
      }
      return true;
    }
    if (tool === "stakeout" || QA_STATE.isPickingStakeoutPoint) {
      const idx = QA_STATE.stakeoutPoints.length + 1;
      QA_STATE.stakeoutPoints.push({
        ptid: `STK-${String(idx).padStart(3, "0")}`,
        easting: Number(twd.e.toFixed(3)),
        northing: Number(twd.n.toFixed(3)),
        elevation: Number(twd.h.toFixed(3)),
        code: "DESIGN_PT",
      });
      runGenerateStakeout(scanId);
      return true;
    }
    return false;
  };

  document.addEventListener("DOMContentLoaded", () => {
    const btnCmpVol = document.getElementById("btnCompareDeltaV");
    if (btnCmpVol) {
      btnCmpVol.addEventListener("click", () => {
        if (window.STATE && window.STATE.activeView === "compare" && typeof switchView === "function") {
          switchView("studio");
        }
        openCompareVolumeTakeoffInspector();
        const baseId = (window.STATE && window.STATE.compareBaseScanId) || (window.STATE && window.STATE.activeScanId) || "";
        const compId = (window.STATE && window.STATE.compareScanId) || baseId;
        runCompareVolumeTakeoff(baseId, compId);
      });
    }
  });

  // Handle URL parameters auto-launching
  if (typeof window !== "undefined" && window.location) {
    try {
      const q = new URLSearchParams(window.location.search);
      const tool = q.get("tool") || q.get("inspect");
      if (["surface_qa", "utility_trace", "compare_volume", "rtk_stakeout"].includes(tool)) {
        const interval = setInterval(() => {
          if (window.STATE && window.STATE.activeScanId && window.studioThree && window.studioThree.scene) {
            clearInterval(interval);
            setTimeout(() => {
              if (tool === "surface_qa") openSurfaceFlatnessQaInspector();
              else if (tool === "utility_trace") openUtilityTracerInspector();
              else if (tool === "compare_volume") openCompareVolumeTakeoffInspector();
              else if (tool === "rtk_stakeout") openRtkStakeoutInspector();
            }, 800);
          }
        }, 400);
        setTimeout(() => clearInterval(interval), 25000);
      }
    } catch (_) {}
  }
})();
