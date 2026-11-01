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
    PLUS: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
    TRASH: `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>`,
    EYE: `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gs-icon"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
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
    flatnessResolutionCm: 15,
    flatnessReportIncludeMaterial: false,
    flatnessObjectsByScan: {},
    flatnessObjects: [],
    activeFlatnessObjectId: null,
    flatnessNextSeq: 1,
    flatnessCache: null,
    flatnessCancelToken: null,
    utilityTrenchPoints: [],
    utilityLastResult: null,
    isPickingUtilityPoint: false,
    stakeoutPoints: [],
    stakeoutLastResult: null,
    isPickingStakeoutPoint: false,
  };

  function getActiveFlatnessScanId() {
    return (window.STATE && window.STATE.activeScanId) || "scan";
  }

  function getFlatnessObjectsForActiveScan() {
    const scanId = getActiveFlatnessScanId();
    if (!QA_STATE.flatnessObjectsByScan || typeof QA_STATE.flatnessObjectsByScan !== "object") {
      QA_STATE.flatnessObjectsByScan = {};
    }
    if (!Array.isArray(QA_STATE.flatnessObjectsByScan[scanId])) {
      QA_STATE.flatnessObjectsByScan[scanId] = [];
    }
    QA_STATE.flatnessObjects = QA_STATE.flatnessObjectsByScan[scanId];
    return QA_STATE.flatnessObjects;
  }

  function getActiveFlatnessObject() {
    const list = getFlatnessObjectsForActiveScan();
    if (!QA_STATE.activeFlatnessObjectId) return null;
    return list.find((o) => o && o.id === QA_STATE.activeFlatnessObjectId) || null;
  }

  function getFlatnessRegulationSpec(tolMm) {
    const tol = Number(tolMm) || 3.0;
    if (tol <= 4.5) {
      return {
        code: "PCC 09611",
        clause: "行政院公共工程委員會《施工綱要規範》第09611章「整體粉光地坪」",
        zh: "行政院公共工程委員會《施工綱要規範》第09611章「整體粉光地坪」(3m直規 ±3mm)",
        en: "PCC Spec Ch.09611 Monolithic Floor Troweling (3m ±3mm)",
        url: "https://www.nlma.gov.tw/filesys/file/chinese/dept/bw2/09611.pdf",
      };
    }
    if (tol <= 8.0) {
      return {
        code: "PCC 09220",
        clause: "行政院公共工程委員會《施工綱要規範》第09220章「水泥砂漿粉刷」",
        zh: "行政院公共工程委員會《施工綱要規範》第09220章「水泥砂漿粉刷」(3m直規 ±6mm)",
        en: "PCC Spec Ch.09220 Cement Mortar Plastering (3m ±6mm)",
        url: "https://www.nlma.gov.tw/uploads/files/b540c458d9a9ace031fb2cec987593c0.pdf",
      };
    }
    if (tol <= 12.5) {
      return {
        code: "PCC 03310",
        clause: "行政院公共工程委員會《施工綱要規範》第03310章「結構用混凝土」",
        zh: "行政院公共工程委員會《施工綱要規範》第03310章「結構用混凝土」模板粗底 (±10mm)",
        en: "PCC Spec Ch.03310 Structural Concrete Formwork (±10mm)",
        url: "https://www.nlma.gov.tw/uploads/files/896a8dbb1440cce3f17b09e0a4b8dcff.pdf",
      };
    }
    return {
      code: "PCC 02742",
      clause: "行政院公共工程委員會《施工綱要規範》第02742章「瀝青混凝土鋪面及基層」",
      zh: `行政院公共工程委員會《施工綱要規範》第02742章「瀝青混凝土鋪面及基層」公差 (±${Number(tol.toFixed(1))}mm)`,
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

  function clearStakeoutVisuals3D() {
    stakeout3DGroup = clear3DGroup(stakeout3DGroup);
    if (window.STATE && Array.isArray(window.STATE.badges2D)) {
      window.STATE.badges2D = window.STATE.badges2D.filter((b) => {
        if (b && b.surveyTool === "stakeout") {
          if (b.el && typeof b.el.remove === "function") b.el.remove();
          return false;
        }
        return true;
      });
    }
    if (window.studioThree && window.studioThree.renderer && window.studioThree.scene && window.studioThree.camera) {
      window.studioThree.renderer.render(window.studioThree.scene, window.studioThree.camera);
    }
  }
  window.clearStakeoutVisuals3D = clearStakeoutVisuals3D;

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
      clearStakeoutVisuals3D();
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
   * Tests whether a 3D Tiles node's bounding volume (in tr.group local coordinates)
   * intersects the world-space 3D AABB of the flatness inspection polygon.
   */
  function doesTileNodeIntersectBox(node, grpMat, polyBox) {
    const THREE = window.THREE;
    if (!node || !THREE || !polyBox) return true;
    const bv = node.engineData?.boundingVolume;
    if (bv) {
      try {
        if (typeof bv.getAABB === "function") {
          const localBox = new THREE.Box3();
          bv.getAABB(localBox);
          if (!localBox.isEmpty()) {
            if (grpMat) localBox.applyMatrix4(grpMat);
            return localBox.intersectsBox(polyBox);
          }
        }
        if (typeof bv.getSphere === "function") {
          const localSphere = new THREE.Sphere();
          bv.getSphere(localSphere);
          if (localSphere.radius > 0) {
            if (grpMat) localSphere.applyMatrix4(grpMat);
            return polyBox.intersectsSphere(localSphere);
          }
        }
      } catch (_) {}
    }
    const rawBv = node.boundingVolume;
    if (rawBv && Array.isArray(rawBv.box) && rawBv.box.length >= 12) {
      const b = rawBv.box;
      const cx = b[0], cy = b[1], cz = b[2];
      const rx = Math.abs(b[3]) + Math.abs(b[6]) + Math.abs(b[9]);
      const ry = Math.abs(b[4]) + Math.abs(b[7]) + Math.abs(b[10]);
      const rz = Math.abs(b[5]) + Math.abs(b[8]) + Math.abs(b[11]);
      const tileBox = new THREE.Box3(
        new THREE.Vector3(cx - rx, cy - ry, cz - rz),
        new THREE.Vector3(cx + rx, cy + ry, cz + rz)
      );
      if (grpMat) tileBox.applyMatrix4(grpMat);
      return tileBox.intersectsBox(polyBox);
    }
    return true;
  }

  /**
   * Guarantees that the deepest (MAX quality / leaf) 3D tiles intersecting the polygon's 3D AABB
   * are preprocessed, requested, downloaded, and parsed into `node.engineData.scene` before sampling,
   * even if the user's current viewing LOD is set to `ROUGH` (`STATE.scanLodMode === "rough"`)
   * or if those leaf tiles were not yet loaded in the viewport.
   */
  async function ensureMaxQualityTilesForFlatnessBoxAsync(minX, maxX, minY, maxY, minZ, maxZ, onProgress, cancelToken) {
    const st = window.studioThree;
    const THREE = window.THREE;
    if (!st || !THREE) return { leafCount: 0, maxDepth: 0 };

    // If a low-memory coarse preview_tileset.json was loaded on mobile/rough mode, upgrade to full tileset.json first
    if (st._loadedLowMemTileset && window.STATE?.activeScanId && typeof window.loadScanIntoStudio === "function") {
      try {
        window.loadScanIntoStudio(window.STATE.activeScanId, {
          preserveCamera: true,
          preserveTools: true,
          forceFullRes: true,
        });
        const tUpgrade = performance.now();
        while (performance.now() - tUpgrade < 2200) {
          if (cancelToken && cancelToken.cancelled) break;
          if (st.tilesRenderer && st.tilesRenderer.root && !st._loadedLowMemTileset) break;
          await new Promise((r) => setTimeout(r, 40));
        }
      } catch (_) {}
    }

    const tr = st.tilesRenderer;
    if (!tr || !tr.root) return { leafCount: 0, maxDepth: 0 };

    if (st.modelPivot && typeof st.modelPivot.updateMatrixWorld === "function") {
      st.modelPivot.updateMatrixWorld(true);
    }
    if (tr.group && typeof tr.group.updateMatrixWorld === "function") {
      tr.group.updateMatrixWorld(true);
    }
    const grpMat = tr.group ? tr.group.matrixWorld : (st.modelPivot ? st.modelPivot.matrixWorld : null);
    const polyBox = new THREE.Box3(
      new THREE.Vector3(minX - 0.25, minY - 0.25, minZ - 0.25),
      new THREE.Vector3(maxX + 0.25, maxY + 0.25, maxZ + 0.25)
    );

    // Temporarily suspend viewport tr.update() from clearing tr.usedSet / aborting queued leaf tiles in ROUGH mode,
    // and ensure cache capacity is large enough that requested leaf tiles are never evicted during analysis
    const origTrUpdate = typeof tr.update === "function" ? tr.update : null;
    if (origTrUpdate) {
      tr.update = function () {};
    }
    const lru = tr.lruCache;
    const savedMinSize = lru ? lru.minSize : null;
    const savedMaxSize = lru ? lru.maxSize : null;
    const savedMinBytes = lru ? lru.minBytesSize : null;
    const savedMaxBytes = lru ? lru.maxBytesSize : null;
    if (lru) {
      lru.minSize = Math.max(lru.minSize || 0, 800);
      lru.maxSize = Math.max(lru.maxSize || 0, 1600);
      if (typeof lru.minBytesSize === "number") lru.minBytesSize = Math.max(lru.minBytesSize, 800 * 1024 * 1024);
      if (typeof lru.maxBytesSize === "number") lru.maxBytesSize = Math.max(lru.maxBytesSize, 1600 * 1024 * 1024);
    }
    if (tr.downloadQueue && typeof tr.downloadQueue.maxJobs === "number") {
      tr.downloadQueue.maxJobs = Math.max(tr.downloadQueue.maxJobs, 12);
    }
    if (tr.parseQueue && typeof tr.parseQueue.maxJobs === "number") {
      tr.parseQueue.maxJobs = Math.max(tr.parseQueue.maxJobs, 6);
    }

    const collectAndRequestIntersectingTiles = () => {
      const targetLeaves = [];
      const pendingSubTilesets = [];
      let maxDepthFound = 0;

      const visit = (node, depth) => {
        if (!node) return;
        if (typeof tr.ensureChildrenArePreprocessed === "function") {
          try {
            tr.ensureChildrenArePreprocessed(node, true);
          } catch (_) {}
        }
        if (!doesTileNodeIntersectBox(node, grpMat, polyBox)) return;
        if (depth > maxDepthFound) maxDepthFound = depth;

        if (typeof tr.markTileUsed === "function") {
          try {
            tr.markTileUsed(node);
          } catch (_) {}
        }

        const ch = Array.isArray(node.children) ? node.children : [];
        const cached = node.internal || node.engineData?.cached || node.cached;
        const hasUnrenderable = Boolean(cached && cached.hasUnrenderableContent);
        const hasSceneLoaded = Boolean(node.engineData?.scene || node.cached?.scene);
        const hasRenderable = Boolean(
          (cached && cached.hasRenderableContent) ||
          node.content?.uri ||
          node.content?.url ||
          node.cached !== undefined ||
          node.engineData !== undefined
        );
        const reqTile = (n) => {
          if (typeof tr.requestTileContents === "function") {
            try { tr.requestTileContents(n); } catch (_) {}
          } else if (typeof tr.loadTileContents === "function") {
            try { tr.loadTileContents(n); } catch (_) {}
          }
        };

        // External sub-tileset JSON node that hasn't expanded its children yet
        if (hasUnrenderable && ch.length === 0) {
          reqTile(node);
          pendingSubTilesets.push(node);
          return;
        }

        if (ch.length > 0) {
          for (let i = 0; i < ch.length; i++) {
            visit(ch[i], depth + 1);
          }
          // If this is an ADD-refinement parent tile, also ensure its content is loaded
          if (node.refine === "ADD" && hasRenderable) {
            if (!hasSceneLoaded) reqTile(node);
            targetLeaves.push(node);
          }
        } else if (hasRenderable) {
          if (!hasSceneLoaded) reqTile(node);
          targetLeaves.push(node);
        }
      };

      visit(tr.root, 0);
      return { targetLeaves, pendingSubTilesets, maxDepthFound };
    };

    const isTileSettled = (node) => {
      if (!node) return true;
      if (node.engineData?.scene || node.cached?.scene) return true;
      const stCode = node.internal?.loadingState ?? node.engineData?.loadingState;
      // loadingState === 4 (LOADED) or -1 (FAILED)
      if (stCode === 4 || stCode === -1) return true;
      return false;
    };

    const isSubTilesetSettled = (node) => {
      if (!node) return true;
      if (Array.isArray(node.children) && node.children.length > 0) return true;
      const stCode = node.internal?.loadingState ?? node.engineData?.loadingState;
      if (stCode === 4 || stCode === -1) return true;
      return false;
    };

    const startWait = performance.now();
    const maxWaitMs = 4500;
    let lastInfo = collectAndRequestIntersectingTiles();

    try {
      while (performance.now() - startWait < maxWaitMs) {
        if (cancelToken && cancelToken.cancelled) break;
        lastInfo = collectAndRequestIntersectingTiles();
        const { targetLeaves, pendingSubTilesets } = lastInfo;

        // Keep marking target leaves as used so LRU never unloads them
        for (let i = 0; i < targetLeaves.length; i++) {
          if (typeof tr.markTileUsed === "function") {
            try {
              tr.markTileUsed(targetLeaves[i]);
            } catch (_) {}
          }
        }

        const allSubDone = pendingSubTilesets.every(isSubTilesetSettled);
        const loadedLeaves = targetLeaves.filter(isTileSettled).length;
        if (allSubDone && loadedLeaves >= targetLeaves.length) {
          break;
        }

        if (typeof onProgress === "function" && targetLeaves.length > 0) {
          const ratio = loadedLeaves / Math.max(1, targetLeaves.length);
          onProgress(Math.min(18, Math.max(2, Math.round(ratio * 18))));
        }

        await new Promise((r) => setTimeout(r, 35));
      }
    } finally {
      if (origTrUpdate) {
        tr.update = origTrUpdate;
      }
      if (lru && savedMinSize !== null && savedMaxSize !== null) {
        lru.minSize = Math.max(savedMinSize, 400);
        lru.maxSize = Math.max(savedMaxSize, 800);
        if (typeof savedMinBytes === "number") lru.minBytesSize = Math.max(savedMinBytes, 400 * 1024 * 1024);
        if (typeof savedMaxBytes === "number") lru.maxBytesSize = Math.max(savedMaxBytes, 800 * 1024 * 1024);
      }
    }

    const loadedLeafScenes = lastInfo.targetLeaves.filter((n) => Boolean(n?.engineData?.scene)).length;
    return {
      leafCount: loadedLeafScenes,
      totalTargetLeaves: lastInfo.targetLeaves.length,
      maxDepth: lastInfo.maxDepthFound,
    };
  }

  /**
   * Time-sliced background surface sampler inside the 3D polygon.
   * Always forces MAX 3D tile quality (deepest leaf tiles intersecting the polygon AABB)
   * even when the viewport LOD mode is set to ROUGH (`STATE.scanLodMode === "rough"`),
   * and uses a strictly uniform square grid (`du = dv = cellSizeM`) controlled by `QA_STATE.flatnessResolutionCm`.
   */
  function computeClientFlatnessPolygonAsync(polyPts, planeMode, onProgress, cancelToken, resolutionCm = null) {
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

      let rawMinU = Infinity, rawMaxU = -Infinity, rawMinV = Infinity, rawMaxV = -Infinity;
      for (let i = 0; i < polyUV.length; i++) {
        if (polyUV[i].u < rawMinU) rawMinU = polyUV[i].u;
        if (polyUV[i].u > rawMaxU) rawMaxU = polyUV[i].u;
        if (polyUV[i].v < rawMinV) rawMinV = polyUV[i].v;
        if (polyUV[i].v > rawMaxV) rawMaxV = polyUV[i].v;
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
      const rawSpanU = Math.max(0.2, rawMaxU - rawMinU);
      const rawSpanV = Math.max(0.2, rawMaxV - rawMinV);
      const normalMargin = Math.min(1.5, Math.max(0.32, maxPolyAbsN + 0.30));
      minX -= normalMargin; maxX += normalMargin;
      minY -= normalMargin; maxY += normalMargin;
      minZ -= normalMargin; maxZ += normalMargin;

      // Grid resolution: strictly uniform square cells (du === dv === cellSize) controlled by slider/manual input (cm)
      const reqResCm = Math.max(
        1.0,
        Math.min(200.0, safeFloat(resolutionCm, QA_STATE.flatnessResolutionCm || 15.0))
      );
      const reqCellM = reqResCm / 100.0;
      // Safety ceiling of 25,600 cells (160x160) so huge polygons at tiny cm settings never freeze memory
      const minSafeCellM = Math.sqrt((rawSpanU * rawSpanV) / 25600.0);
      const cellSize = Math.max(0.01, reqCellM, minSafeCellM);
      const cols = Math.max(3, Math.min(200, Math.ceil(rawSpanU / cellSize)));
      const rows = Math.max(3, Math.min(200, Math.ceil(rawSpanV / cellSize)));
      const du = cellSize;
      const dv = cellSize;
      const spanU = cols * du;
      const spanV = rows * dv;
      const midU = 0.5 * (rawMinU + rawMaxU);
      const midV = 0.5 * (rawMinV + rawMaxV);
      const minU = midU - 0.5 * spanU;
      const maxU = midU + 0.5 * spanU;
      const minV = midV - 0.5 * spanV;
      const maxV = midV + 0.5 * spanV;
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

      // First guarantee MAX quality leaf tiles intersecting the polygon 3D AABB are loaded, even in ROUGH mode
      ensureMaxQualityTilesForFlatnessBoxAsync(minX, maxX, minY, maxY, minZ, maxZ, onProgress, cancelToken)
        .then((maxTileInfo) => {
          if (cancelToken && cancelToken.cancelled) {
            reject(new Error("cancelled"));
            return;
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
              if (!fromTileTree && !isNodeVisibleUnderRoot(child, rootObj)) return;
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
              const polyBox = THREE
                ? new THREE.Box3(
                    new THREE.Vector3(minX - 0.25, minY - 0.25, minZ - 0.25),
                    new THREE.Vector3(maxX + 0.25, maxY + 0.25, maxZ + 0.25)
                  )
                : null;
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
                if (!doesTileNodeIntersectBox(node, grpMat, polyBox)) return true;
                const ch = Array.isArray(node.children) ? node.children : [];
                const interCh = ch.filter((c) => doesTileNodeIntersectBox(c, grpMat, polyBox));
                if (interCh.length > 0 && interCh.some((c) => hasAnyLoadedScene(c))) {
                  return interCh.every((c) => hasFullCoverageScene(c));
                }
                return Boolean(node.engineData?.scene);
              };
              const walkTile = (node) => {
                if (!node) return;
                if (!doesTileNodeIntersectBox(node, grpMat, polyBox)) {
                  if (node.engineData?.scene) markGeomsSeen(node.engineData.scene);
                  return;
                }
                const ch = Array.isArray(node.children) ? node.children : [];
                const interCh = ch.filter((c) => doesTileNodeIntersectBox(c, grpMat, polyBox));
                const loadedChildren = interCh.filter((c) => hasAnyLoadedScene(c));
                if (loadedChildren.length > 0) {
                  for (let i = 0; i < loadedChildren.length; i++) {
                    walkTile(loadedChildren[i]);
                  }
                  if (!interCh.every((c) => hasFullCoverageScene(c)) && node.engineData?.scene) {
                    collectFromRoot(node.engineData.scene, grpMat, true, true);
                  } else if (node.engineData?.scene) {
                    // Prevent coarse ancestor LOD tile from being re-collected via st.modelPivot traversal
                    markGeomsSeen(node.engineData.scene);
                  }
                } else if (node.engineData?.scene) {
                  const isCoarseNonLeaf = ch.length > 0 && node.refine !== "ADD";
                  collectFromRoot(node.engineData.scene, grpMat, isCoarseNonLeaf, true);
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
              const pct = Math.min(98, 18 + Math.round((processedUnits / totalUnits) * 80));
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
            let sumAbsMm = 0;
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
              sumAbsMm += Math.abs(devMm);

              if (!maxHigh || devMm > maxHigh.devMm) maxHigh = cell;
              if (!maxLow || devMm < maxLow.devMm) maxLow = cell;
            }

            const nSamples = Math.max(1, sampledCells.length);
            const rmsMm = Math.sqrt(sumSqMm / nSamples);
            const meanAbsMm = sumAbsMm / nSamples;
            fittedPlane.medH = Number((originTwd.h + fc.y).toFixed(3));
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
              resolutionCm: Number((du * 100.0).toFixed(1)),
              requestedResolutionCm: reqResCm,
              maxQualityLeafTilesLoaded: maxTileInfo ? maxTileInfo.leafCount : 0,
              maxQualityTileDepth: maxTileInfo ? maxTileInfo.maxDepth : 0,
              cellAreaM2: effectiveCellAreaM2,
              totalAreaM2: Number((sampledCells.length * effectiveCellAreaM2).toFixed(2)),
              rmsMm: Number(rmsMm.toFixed(2)),
              meanAbsMm: Number(meanAbsMm.toFixed(2)),
              ffFlatness: ffVal,
              flLevelness: flVal,
              maxHigh,
              maxLow,
              spanU: rawSpanU,
              spanV: rawSpanV,
            });
          };

          scheduleNextChunk();
        })
        .catch(reject);
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
      resolution_cm: cache.resolutionCm || Number(((cache.du || 0.15) * 100.0).toFixed(1)),
      volume_mode: volMode,
      total_points: totalPts,
      pass_count: passCount,
      high_count: highCount,
      low_count: lowCount,
      pass_rate_pct: passRatePct,
      rms_dev_mm: cache.rmsMm,
      mean_abs_dev_mm: cache.meanAbsMm !== undefined ? cache.meanAbsMm : Number((cache.rmsMm * 0.8).toFixed(2)),
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

  function createFlatnessTagSprite(tagText, subText, isActive = false, isPlumbWall = false) {
    const THREE = window.THREE;
    if (!THREE || typeof document === "undefined") return null;
    const cvs = document.createElement("canvas");
    cvs.width = 256;
    cvs.height = 76;
    const ctx = cvs.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = isActive ? "rgba(15, 23, 42, 0.94)" : "rgba(15, 23, 42, 0.82)";
    ctx.strokeStyle = isPlumbWall ? "#f59e0b" : isActive ? "#38bdf8" : "#94a3b8";
    ctx.lineWidth = isActive ? 3.5 : 2.0;
    ctx.fillRect(4, 4, 248, 68);
    ctx.strokeRect(4, 4, 248, 68);
    ctx.fillStyle = isPlumbWall ? "#fbbf24" : "#38bdf8";
    ctx.font = "bold 24px Inter, Microsoft JhengHei, sans-serif";
    ctx.fillText(String(tagText || "F1"), 16, 34);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "600 17px Inter, Microsoft JhengHei, sans-serif";
    ctx.fillText(String(subText || ""), 16, 58);
    const tex = new THREE.CanvasTexture(cvs);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(1.8, 0.54, 1);
    sp.renderOrder = 999;
    return sp;
  }

  function appendSingleFlatnessObjectTo3DGroup(grp, cache, metrics, opts = {}) {
    const THREE = window.THREE;
    if (!THREE || !grp || !cache || !cache.plane) return;
    const isActive = Boolean(opts.isActive);
    const showPass3D = Boolean(opts.showPass3D);
    const displayMode = opts.displayMode === "points" ? "points" : "tiles";
    const objLabel = opts.label || "";
    const plane = cache.plane;
    const fc = new THREE.Vector3(plane.center.x, plane.center.y, plane.center.z);
    const fn = new THREE.Vector3(plane.normal.x, plane.normal.y, plane.normal.z).normalize();
    const fu = new THREE.Vector3(plane.uAxis.x, plane.uAxis.y, plane.uAxis.z).normalize();
    const fv = new THREE.Vector3(plane.vAxis.x, plane.vAxis.y, plane.vAxis.z).normalize();

    const rawPolyPts =
      isActive &&
      window.STATE &&
      Array.isArray(window.STATE.flatnessPolygonPoints) &&
      window.STATE.flatnessPolygonPoints.length >= 3
        ? window.STATE.flatnessPolygonPoints
        : cache.polyPts || [];
    const polyPts = rawPolyPts.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const isPlumbWall = plane.planeMode === "vertical_plumb" || Number(plane.slopeDeg) > 55.0;

    if (polyPts.length >= 3) {
      const loopPts = [...polyPts, polyPts[0]];
      const loopGeo = new THREE.BufferGeometry().setFromPoints(loopPts);
      const loopColor = isPlumbWall ? 0xf59e0b : isActive ? 0x0284c7 : 0x64748b;
      const loopMat = new THREE.LineBasicMaterial({
        color: loopColor,
        depthTest: false,
        transparent: !isActive,
        opacity: isActive ? 1.0 : 0.85,
      });
      const loopLine = new THREE.Line(loopGeo, loopMat);
      loopLine.renderOrder = isActive ? 997 : 995;
      grp.add(loopLine);

      polyPts.forEach((p, idx) => {
        const pinColor = idx === 0 ? 0xff3b30 : isActive ? 0x0284c7 : 0x64748b;
        if (isActive && typeof add3DPinMarker === "function") {
          add3DPinMarker(p, pinColor, grp);
        } else {
          const sp = new THREE.Mesh(
            new THREE.SphereGeometry(isActive ? (idx === 0 ? 0.16 : 0.12) : 0.09, 12, 12),
            new THREE.MeshBasicMaterial({ color: pinColor, depthTest: false })
          );
          sp.position.copy(p);
          sp.renderOrder = isActive ? 998 : 995;
          grp.add(sp);
        }
      });
    }

    // Oriented 3D Best-Fit Reference Plane Wireframe Grid
    const basisMat = new THREE.Matrix4().makeBasis(fu, fv, fn);
    const planeGeo = new THREE.PlaneGeometry((cache.spanU || 2) * 1.02, (cache.spanV || 2) * 1.02, 8, 8);
    const planeMat = new THREE.MeshBasicMaterial({
      color: isPlumbWall ? 0xfbbf24 : 0x22d3ee,
      wireframe: true,
      transparent: true,
      opacity: isActive ? 0.42 : 0.24,
      depthTest: false,
    });
    const planeMesh = new THREE.Mesh(planeGeo, planeMat);
    planeMesh.applyMatrix4(basisMat);
    planeMesh.position.copy(fc);
    planeMesh.renderOrder = 994;
    grp.add(planeMesh);

    if (objLabel) {
      const subTxt = `${metrics?.pass_rate_pct ?? 0}% (±${metrics?.tolerance_mm ?? 3}mm)`;
      const tagSp = createFlatnessTagSprite(objLabel, subTxt, isActive, isPlumbWall);
      if (tagSp) {
        tagSp.position.copy(fc).addScaledVector(fn, 0.38);
        grp.add(tagSp);
      }
    }

    // Protruding (> +T, Red/Orange), Intruding (< -T, Blue/Cyan) & Pass (Green) 3D Grid Elements
    const tolMm = Math.max(0.5, metrics?.tolerance_mm || 3.0);
    const cells = cache.cells || [];
    const activeCells = cells.filter((c) => showPass3D || c.status === "high" || c.status === "low");

    if (activeCells.length > 0) {
      const cellGeom =
        displayMode === "points"
          ? new THREE.SphereGeometry(Math.min(cache.du || 0.15, cache.dv || 0.15) * 0.28, 12, 12)
          : new THREE.BoxGeometry((cache.du || 0.15) * 0.92, (cache.dv || 0.15) * 0.92, 1.0);
      const instMat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: isActive ? (displayMode === "points" ? 0.96 : 0.94) : 0.78,
        depthTest: false,
      });
      const instMesh = new THREE.InstancedMesh(cellGeom, instMat, activeCells.length);
      instMesh.renderOrder = isActive ? 996 : 995;

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
          else col.setHex(0xf97316).lerp(new THREE.Color(0xef4444), ratio - 1.0);
        } else if (c.status === "low") {
          if (ratio >= 2.0) col.setHex(0x2563eb);
          else col.setHex(0x06b6d4).lerp(new THREE.Color(0x2563eb), ratio - 1.0);
        } else {
          col.setHex(0x10b981);
        }
        instMesh.setColorAt(i, col);
      }
      instMesh.instanceMatrix.needsUpdate = true;
      if (instMesh.instanceColor) instMesh.instanceColor.needsUpdate = true;
      grp.add(instMesh);
    }
  }

  /**
   * Renders in-progress draft polygon vertices (V1 red, V2..Vn blue) and polyline while drawing,
   * while keeping all previously saved flatness objects for the active scan visible in 3D when the flatness tool is active.
   */
  function refreshFlatnessDraftVisuals() {
    if (!window.studioThree || !window.studioThree.scene || !window.THREE) return;
    if (window.STATE && window.STATE.activeTool && window.STATE.activeTool !== "flatness") {
      surfaceQa3DGroup = clear3DGroup(surfaceQa3DGroup);
      return;
    }
    surfaceQa3DGroup = clear3DGroup(surfaceQa3DGroup);
    surfaceQa3DGroup = new window.THREE.Group();
    surfaceQa3DGroup.name = "GS_SurfaceQA_Overlay";

    // Also render any saved flatness objects for this scan so existing regions stay visible while drawing a new region
    const savedObjs = getFlatnessObjectsForActiveScan();
    for (let i = 0; i < savedObjs.length; i++) {
      const obj = savedObjs[i];
      if (!obj || obj.visible === false || !obj.cache || !obj.metrics) continue;
      appendSingleFlatnessObjectTo3DGroup(surfaceQa3DGroup, obj.cache, obj.metrics, {
        isActive: obj.id === QA_STATE.activeFlatnessObjectId,
        showPass3D: Boolean(obj.showPass3D),
        displayMode: obj.displayMode || "tiles",
        label: obj.code || `F${i + 1}`,
      });
    }

    const pts = window.STATE && Array.isArray(window.STATE.measurePoints) ? window.STATE.measurePoints : [];
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
      countBadge.textContent =
        pts.length === 0
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
   * 3D Deviation Tiles or Points for all saved flatness objects in the active scan (when flatness tool is active).
   */
  function renderPolygonFlatness3DOverlay(cache, metrics, showPass3D = false) {
    if (!window.studioThree || !window.studioThree.scene || !window.THREE) return;
    if (window.STATE && window.STATE.activeTool && window.STATE.activeTool !== "flatness") {
      surfaceQa3DGroup = clear3DGroup(surfaceQa3DGroup);
      return;
    }
    const THREE = window.THREE;
    surfaceQa3DGroup = clear3DGroup(surfaceQa3DGroup);
    surfaceQa3DGroup = new THREE.Group();
    surfaceQa3DGroup.name = "GS_SurfaceQA_Overlay";

    const savedObjs = getFlatnessObjectsForActiveScan();
    let renderedActive = false;

    for (let i = 0; i < savedObjs.length; i++) {
      const obj = savedObjs[i];
      if (!obj || obj.visible === false || !obj.cache || !obj.metrics) continue;
      const isAct = obj.id === QA_STATE.activeFlatnessObjectId;
      if (isAct) renderedActive = true;
      appendSingleFlatnessObjectTo3DGroup(
        surfaceQa3DGroup,
        isAct && cache ? cache : obj.cache,
        isAct && metrics ? metrics : obj.metrics,
        {
          isActive: isAct,
          showPass3D: isAct ? showPass3D : Boolean(obj.showPass3D),
          displayMode: isAct ? QA_STATE.flatnessDisplayMode || "tiles" : obj.displayMode || "tiles",
          label: obj.code || `F${i + 1}`,
        }
      );
    }

    if (!renderedActive && cache && metrics) {
      appendSingleFlatnessObjectTo3DGroup(surfaceQa3DGroup, cache, metrics, {
        isActive: true,
        showPass3D,
        displayMode: QA_STATE.flatnessDisplayMode || "tiles",
        label: "F1",
      });
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

  function renderSavedFlatnessObjectsMenu() {
    const wrap = document.getElementById("flatnessSavedObjectsList");
    const countPill = document.getElementById("lblFlatnessSavedObjectsCount");
    const objs = getFlatnessObjectsForActiveScan();
    if (countPill) countPill.textContent = String(objs.length);
    if (!wrap) return;

    if (objs.length === 0) {
      wrap.innerHTML = `
        <div style="font-size:10px;color:var(--ui-text-muted);padding:6px 4px;text-align:center;">
          ${t("尚無已儲存檢測區塊 — 於 3D 表面框選多邊形分析後將自動儲存於此清單", "No saved inspection regions yet — draw & analyze a polygon on the 3D surface to save it here")}
        </div>
      `;
      return;
    }

    const modeNameZh = (m, slopeDeg) => {
      if (m === "vertical_plumb" || Number(slopeDeg) > 55) return t("鉛直牆面", "Plumb Wall");
      if (m === "horizontal") return t("水平地坪", "Horizontal");
      return t("最佳擬合", "Best-Fit");
    };

    wrap.innerHTML = objs
      .map((obj, idx) => {
        const isAct = obj.id === QA_STATE.activeFlatnessObjectId;
        const m = obj.metrics || {};
        const p = obj.cache?.plane || {};
        const isPlumb = obj.planeMode === "vertical_plumb" || Number(p.slopeDeg) > 55;
        const passPct = m.pass_rate_pct ?? 0;
        const passColor = passPct >= 85 ? "#10b981" : passPct >= 70 ? "#f59e0b" : "#ef4444";
        const resCm = Number(obj.resolutionCm || obj.cache?.resolutionCm || QA_STATE.flatnessResolutionCm || 15).toFixed(0);
        return `
          <div class="gs-flatness-obj-item" data-flatness-obj-id="${obj.id}"
               style="display:flex;align-items:center;justify-content:space-between;gap:5px;padding:5px 7px;margin-bottom:4px;border-radius:6px;cursor:pointer;border:1px solid ${
                 isAct ? "#38bdf8" : "var(--ui-border)"
               };background:${isAct ? "rgba(2,132,199,0.16)" : "var(--ui-bg-subtle)"};transition:all 0.12s;">
            <div style="display:flex;align-items:center;gap:6px;min-width:0;flex:1;" data-flatness-select-id="${obj.id}">
              <span style="flex-shrink:0;font-size:10px;font-weight:800;padding:1px 5px;border-radius:4px;background:${
                isPlumb ? "rgba(245,158,11,0.22)" : "rgba(2,132,199,0.22)"
              };color:${isPlumb ? "#fbbf24" : "#38bdf8"};font-family:monospace;">
                ${obj.code || `F${idx + 1}`}
              </span>
              <div style="min-width:0;flex:1;">
                <div style="font-size:10.5px;font-weight:700;color:var(--ui-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                  ${obj.name || `${modeNameZh(obj.planeMode, p.slopeDeg)} (${m.total_area_m2 || 0} m²)`}
                </div>
                <div style="font-size:9.5px;color:var(--ui-text-muted);font-family:monospace;">
                  ±${Number(obj.toleranceMm || 3).toFixed(1)}mm · ${resCm}cm · <span style="color:${passColor};font-weight:700;">${passPct}%</span>
                </div>
              </div>
            </div>
            <div style="display:inline-flex;align-items:center;gap:3px;flex-shrink:0;">
              <button type="button" class="btn-xs" data-flatness-vis-id="${obj.id}"
                      style="padding:2px 5px;opacity:${obj.visible === false ? "0.4" : "1"};"
                      title="${t("顯示/隱藏此 3D 區塊", "Show/Hide 3D overlay")}">
                ${QA_SVGS.EYE}
              </button>
              <button type="button" class="btn-xs" data-flatness-del-id="${obj.id}"
                      style="padding:2px 5px;color:#ef4444;"
                      title="${t("刪除此檢測區塊", "Delete inspection region")}">
                ${QA_SVGS.TRASH}
              </button>
            </div>
          </div>
        `;
      })
      .join("");

    wrap.querySelectorAll("[data-flatness-select-id]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = el.getAttribute("data-flatness-select-id");
        if (id) selectFlatnessObject(id);
      });
    });

    wrap.querySelectorAll("[data-flatness-vis-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-flatness-vis-id");
        if (id) toggleFlatnessObjectVisibility(id);
      });
    });

    wrap.querySelectorAll("[data-flatness-del-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-flatness-del-id");
        if (id) deleteFlatnessObject(id);
      });
    });
  }

  function syncControlsToActiveFlatnessObject(obj) {
    if (!obj) return;
    QA_STATE.flatnessPlaneMode = obj.planeMode || "best_fit_3d";
    QA_STATE.flatnessToleranceMm = Number(obj.toleranceMm) || 3.0;
    QA_STATE.flatnessVolumeMode = obj.volumeMode || "threshold";
    QA_STATE.flatnessDisplayMode = obj.displayMode || "tiles";
    QA_STATE.flatnessShowPass3D = Boolean(obj.showPass3D);
    QA_STATE.flatnessResolutionCm = Number(obj.resolutionCm || obj.cache?.resolutionCm) || 15;
    QA_STATE.flatnessCache = obj.cache;
    QA_STATE.surfaceQaLastResult = obj.metrics;

    if (window.STATE && Array.isArray(obj.polyPts) && obj.polyPts.length >= 3) {
      const THREE = window.THREE;
      window.STATE.measurePoints = [];
      window.STATE.polygonLocked = true;
      window.STATE.flatnessPolygonLocked = true;
      window.STATE.flatnessPolygonPoints = obj.polyPts.map((p) =>
        THREE ? new THREE.Vector3(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0) : { x: Number(p.x) || 0, y: Number(p.y) || 0, z: Number(p.z) || 0 }
      );
    }

    document.querySelectorAll('#surfaceQaContainer input[name="qaRefMode"]').forEach((r) => {
      const match = r.value === QA_STATE.flatnessPlaneMode;
      r.checked = match;
      r.closest(".gs-qa-mode-pill")?.classList.toggle("active", match);
    });
    document.querySelectorAll('#surfaceQaContainer input[name="flatnessVolMode"]').forEach((r) => {
      const match = r.value === QA_STATE.flatnessVolumeMode;
      r.checked = match;
      r.closest(".gs-qa-mode-pill")?.classList.toggle("active", match);
    });
    const rngTol = document.getElementById("rngFlatnessToleranceMm");
    const inpTol = document.getElementById("qaToleranceMm");
    if (rngTol) rngTol.value = String(Math.min(50, QA_STATE.flatnessToleranceMm));
    if (inpTol) inpTol.value = String(QA_STATE.flatnessToleranceMm);

    const rngRes = document.getElementById("rngFlatnessResolutionCm");
    const inpRes = document.getElementById("inpFlatnessResolutionCm");
    const lblRes = document.getElementById("lblFlatnessResReadout");
    if (rngRes) rngRes.value = String(Math.min(100, Math.max(2, QA_STATE.flatnessResolutionCm)));
    if (inpRes) inpRes.value = String(QA_STATE.flatnessResolutionCm);
    if (lblRes) lblRes.textContent = `${QA_STATE.flatnessResolutionCm} cm`;

    const chkPass = document.getElementById("chkFlatnessShowPass3D");
    if (chkPass) chkPass.checked = QA_STATE.flatnessShowPass3D;
  }

  function selectFlatnessObject(objId, focusCam = true) {
    const objs = getFlatnessObjectsForActiveScan();
    const target = objs.find((o) => o && o.id === objId);
    if (!target) return null;
    QA_STATE.activeFlatnessObjectId = target.id;
    target.visible = true;
    syncControlsToActiveFlatnessObject(target);
    renderSavedFlatnessObjectsMenu();
    recomputeFlatnessMetricsAndVisuals();

    const badgeState = document.getElementById("badgeFlatnessPolyState");
    if (badgeState) badgeState.textContent = `${target.code || "F"} ${t("已選取", "Selected")}`;
    const lblCount = document.getElementById("lblFlatnessVertexCount");
    if (lblCount && target.cache) {
      lblCount.textContent = t(
        `正在編輯 ${target.code} (${target.cache.totalAreaM2} m²) — 可拖曳頂點或調整專屬設定`,
        `Editing ${target.code} (${target.cache.totalAreaM2} m²) — drag 3D pins or adjust settings`
      );
    }

    if (focusCam && window.studioThree?.camera && window.studioThree?.controls && target.cache?.plane?.center && window.THREE) {
      const c = target.cache.plane.center;
      window.studioThree.controls.target.set(c.x, c.y, c.z);
      window.studioThree.controls.update();
      if (window.studioThree.renderer && window.studioThree.scene) {
        window.studioThree.renderer.render(window.studioThree.scene, window.studioThree.camera);
      }
    }
    return target;
  }

  function toggleFlatnessObjectVisibility(objId) {
    const objs = getFlatnessObjectsForActiveScan();
    const target = objs.find((o) => o && o.id === objId);
    if (!target) return;
    target.visible = target.visible === false ? true : false;
    renderSavedFlatnessObjectsMenu();
    if (QA_STATE.flatnessCache && QA_STATE.surfaceQaLastResult) {
      renderPolygonFlatness3DOverlay(QA_STATE.flatnessCache, QA_STATE.surfaceQaLastResult, QA_STATE.flatnessShowPass3D);
    } else {
      refreshFlatnessDraftVisuals();
    }
  }

  function deleteFlatnessObject(objId) {
    const objs = getFlatnessObjectsForActiveScan();
    const idx = objs.findIndex((o) => o && o.id === objId);
    if (idx < 0) return;
    objs.splice(idx, 1);
    if (QA_STATE.activeFlatnessObjectId === objId) {
      if (objs.length > 0) {
        const nextObj = objs[Math.max(0, idx - 1)];
        selectFlatnessObject(nextObj.id, false);
        return;
      }
      QA_STATE.activeFlatnessObjectId = null;
      QA_STATE.flatnessCache = null;
      QA_STATE.surfaceQaLastResult = null;
      if (window.STATE) {
        window.STATE.measurePoints = [];
        window.STATE.polygonLocked = false;
        window.STATE.flatnessPolygonLocked = false;
        window.STATE.flatnessPolygonPoints = [];
      }
      const resEl = document.getElementById("surfaceQaResultsCard");
      if (resEl) resEl.style.display = "none";
    }
    renderSavedFlatnessObjectsMenu();
    if (QA_STATE.flatnessCache && QA_STATE.surfaceQaLastResult) {
      renderPolygonFlatness3DOverlay(QA_STATE.flatnessCache, QA_STATE.surfaceQaLastResult, QA_STATE.flatnessShowPass3D);
    } else {
      refreshFlatnessDraftVisuals();
    }
  }

  function startNewFlatnessObjectDraft(showHintToast = true) {
    cancelActiveFlatnessJob();
    QA_STATE.activeFlatnessObjectId = null;
    QA_STATE.flatnessCache = null;
    QA_STATE.surfaceQaLastResult = null;
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
    const resEl = document.getElementById("surfaceQaResultsCard");
    if (resEl) resEl.style.display = "none";
    const badgeState = document.getElementById("badgeFlatnessPolyState");
    if (badgeState) badgeState.textContent = t("新增繪製中", "New Draft");
    renderSavedFlatnessObjectsMenu();
    refreshFlatnessDraftVisuals();
    if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
    if (showHintToast && typeof showToast === "function") {
      showToast(t("請於 3D 表面點擊 3+ 個頂點框選新檢測區域（既有區塊已保留）", "Click 3+ pts on 3D surface to add a new flatness region (existing regions preserved)"));
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
      QA_STATE.activeFlatnessObjectId = null;
    }

    const savedObjs = getFlatnessObjectsForActiveScan();
    if (!QA_STATE.flatnessCache && savedObjs.length > 0) {
      const lastObj = savedObjs.find((o) => o.id === QA_STATE.activeFlatnessObjectId) || savedObjs[savedObjs.length - 1];
      if (lastObj) {
        QA_STATE.activeFlatnessObjectId = lastObj.id;
        QA_STATE.flatnessCache = lastObj.cache;
        QA_STATE.surfaceQaLastResult = lastObj.metrics;
        QA_STATE.flatnessPlaneMode = lastObj.planeMode || "best_fit_3d";
        QA_STATE.flatnessToleranceMm = Number(lastObj.toleranceMm) || 3.0;
        QA_STATE.flatnessVolumeMode = lastObj.volumeMode || "threshold";
        QA_STATE.flatnessDisplayMode = lastObj.displayMode || "tiles";
        QA_STATE.flatnessShowPass3D = Boolean(lastObj.showPass3D);
        QA_STATE.flatnessResolutionCm = Number(lastObj.resolutionCm || lastObj.cache?.resolutionCm) || 15;
      }
    }

    const tolMm = QA_STATE.flatnessToleranceMm || 3.0;
    const resCm = QA_STATE.flatnessResolutionCm || 15;
    const planeMode = QA_STATE.flatnessPlaneMode || "best_fit_3d";
    const volMode = QA_STATE.flatnessVolumeMode || "threshold";
    const dispMode = QA_STATE.flatnessDisplayMode || "tiles";
    const includeMat = Boolean(QA_STATE.flatnessReportIncludeMaterial);
    const ptsCount = window.STATE && Array.isArray(window.STATE.measurePoints) ? window.STATE.measurePoints.length : 0;
    const isSampling = Boolean(QA_STATE.flatnessCancelToken && !QA_STATE.flatnessCancelToken.cancelled);
    const regSpec = getFlatnessRegulationSpec(tolMm);

    const html = `
      <div class="gs-qa-container" id="surfaceQaContainer">
        ${typeof window.renderSurveyToolExplanationBannerHtml === "function" ? window.renderSurveyToolExplanationBannerHtml(
          "3D 區域平整度與補料分析",
          "3D Surface Flatness & Material Takeoff",
          "於 3D 模型框選多處地坪或牆面範圍，最高精度載入點雲/網格擬合基準平面，並依公共工程施工綱要規範檢核公差、合格率與產出多區塊工程檢驗報告。",
          "Draw multiple 3D polygons on slabs or walls at MAX tile quality to fit reference planes, inspect deviations against PCC tolerance specs, and export a multi-region engineering report."
        ) : ""}
        <!-- Header & Taiwan PCC Spec Pill -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:4px;">
          <span style="font-size:12px;font-weight:700;color:var(--ui-text-primary);display:inline-flex;align-items:center;gap:5px;">
            ${QA_SVGS.FLATNESS} ${t("區域平整度與補料分析", "Flatness & Material Takeoff")}
          </span>
          <span class="gcp-crs-pill" id="lblFlatnessSpecChapter">${regSpec.code}</span>
        </div>

        <!-- Saved Flatness Objects Menu (Visible only when Flatness tool is active) -->
        <div class="gs-qa-card" id="flatnessSavedObjectsMenuWrap" style="margin-bottom:6px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
            <span style="font-size:11px;font-weight:700;color:var(--ui-text-primary);display:inline-flex;align-items:center;gap:5px;">
              ${t("已儲存檢測區塊清單", "Saved Flatness Regions")}
              <span id="lblFlatnessSavedObjectsCount" style="font-size:10px;padding:0 6px;border-radius:999px;background:rgba(2,132,199,0.18);color:#38bdf8;font-weight:800;">${savedObjs.length}</span>
            </span>
            <button type="button" class="btn-xs primary" id="btnNewFlatnessObject" style="padding:2px 8px;font-size:10px;" title="${t("保留現有區塊並框選新增另一處平整度檢測區塊", "Keep existing regions and draw a new flatness region")}">
              ${QA_SVGS.PLUS} ${t("新增", "New")}
            </button>
          </div>
          <div id="flatnessSavedObjectsList" style="max-height:132px;overflow-y:auto;"></div>
        </div>

        <!-- Step 1: 3D Polygon Drawing Guide & Controls -->
        <div class="gs-qa-card" id="flatnessStep1Card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <span style="font-size:11px;font-weight:700;color:var(--ui-text-primary);">
              1. ${t("檢測範圍 (可拖曳頂點微調)", "Inspection Polygon (Draggable)")}
            </span>
            <span id="badgeFlatnessPolyState" style="font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(2,132,199,0.15);color:#38bdf8;font-weight:700;">
              ${isSampling ? t("計算中...", "Sampling...") : QA_STATE.flatnessCache ? t("已鎖定", "Locked") : t("繪製中", "Drawing")}
            </span>
          </div>
          <div id="lblFlatnessVertexCount" style="font-size:10.5px;color:var(--ui-text-secondary);line-height:1.35;margin-bottom:6px;">
            ${
              QA_STATE.flatnessCache
                ? t(`已分析 ${QA_STATE.flatnessCache.totalAreaM2} m² — 可直接拖曳 3D 頂點或點「新增」框選下一個區域`, `Analyzed ${QA_STATE.flatnessCache.totalAreaM2} m² — drag 3D pins or click 'New' for another region`)
                : isSampling
                ? t("最高精度圖磚載入與網格取樣中...", "Loading MAX quality tiles & sampling grid...")
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
            <button type="button" class="btn-xs" id="btnResetSurfaceQa" title="${t("開始框選新區域（保留已儲存區塊）", "Start drawing a new polygon (keeps saved regions)")}">
              ${QA_SVGS.PICK} ${t("重繪", "Redraw")}
            </button>
          </div>
          <!-- Background Time-Sliced Sampling Progress Bar -->
          <div id="flatnessSamplingProgressWrap" style="display:${isSampling ? "block" : "none"};margin-top:7px;">
            <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--ui-text-secondary);margin-bottom:3px;">
              <span id="lblFlatnessSamplingStage">${t("強制載入 MAX 最高精度圖磚與平面擬合中...", "Loading MAX quality 3D tiles & fitting plane...")}</span>
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
            2. ${t("基準平面", "Reference Plane")}
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

        <!-- Step 3: Taiwan PCC Regulation Presets, Tolerance Slider & Uniform Tile Resolution Slider/Input -->
        <div class="gs-qa-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <span style="font-size:11px;font-weight:700;color:var(--ui-text-secondary);">
              3. ${t("公差門檻", "Tolerance")}
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

          <!-- Real-Time Tolerance Slider + Numeric Input -->
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <input type="range" id="rngFlatnessToleranceMm" min="0.5" max="50" step="0.5" value="${tolMm}" style="flex:1;accent-color:#0284c7;cursor:pointer;" />
            <input type="number" id="qaToleranceMm" class="gs-input" value="${tolMm}" step="0.5" min="0.5" max="100" style="width:68px;height:26px;font-size:11px;text-align:right;" />
          </div>

          <!-- Uniform Grid / Tile Resolution Slider + Manual Input (cm) -->
          <div style="border-top:1px solid var(--ui-border);padding-top:6px;margin-top:4px;margin-bottom:6px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
              <span style="font-size:10.5px;font-weight:700;color:var(--ui-text-secondary);">
                4. ${t("網格色塊解析度 (固定正方格)", "Grid Tile Resolution (Square)")}
              </span>
              <span id="lblFlatnessResReadout" style="font-size:11px;font-weight:800;color:#38bdf8;font-family:monospace;">
                ${resCm} cm
              </span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <input type="range" id="rngFlatnessResolutionCm" min="2" max="100" step="1" value="${Math.min(100, Math.max(2, resCm))}" style="flex:1;accent-color:#0284c7;cursor:pointer;" />
              <input type="number" id="inpFlatnessResolutionCm" class="gs-input" value="${resCm}" step="1" min="1" max="200" style="width:68px;height:26px;font-size:11px;text-align:right;" />
            </div>
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
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:5px;">
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
            <label style="display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--ui-text-secondary);cursor:pointer;">
              <input type="checkbox" id="chkFlatnessReportIncludeMaterial" ${includeMat ? "checked" : ""} />
              <span>${t("檢驗報告顯示補料/打磨材料數量估算 (預設隱藏)", "Include material volume & mortar bag estimate in report (hidden by default)")}</span>
            </label>
          </div>
        </div>

        <!-- Export & Report Toolbar -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;">
          <button type="button" class="btn-xs" id="btnExportSurfaceQaCsv" title="${t("匯出格網偏差與體積 CSV", "Export Grid & Volume CSV")}">
            ${QA_SVGS.CSV} CSV
          </button>
          <button type="button" class="btn-xs primary" id="btnExportFlatnessReport" title="${t("產生含全區俯視圖與各區塊 3D/正射截圖之工程檢驗報告", "Generate Engineering Report with Top-Down Overview & All Region Screenshots")}">
            ${QA_SVGS.PRINT} ${t("截圖報告", "Report")}
          </button>
        </div>

        <!-- Dynamic Results Card -->
        <div id="surfaceQaResultsCard" style="display:none;margin-top:8px;"></div>
      </div>
    `;

    showSidePanel(t("表面平整度", "Surface Flatness"), html);
    renderSavedFlatnessObjectsMenu();
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
    const showPassEl = document.getElementById("chkFlatnessShowPass3D");
    const showPass = showPassEl ? Boolean(showPassEl.checked) : Boolean(QA_STATE.flatnessShowPass3D);
    QA_STATE.flatnessShowPass3D = showPass;
    const incMatEl = document.getElementById("chkFlatnessReportIncludeMaterial");
    if (incMatEl) {
      QA_STATE.flatnessReportIncludeMaterial = Boolean(incMatEl.checked);
    }

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

    // Persist updated settings onto the currently selected saved flatness object
    const activeObj = getActiveFlatnessObject();
    if (activeObj) {
      activeObj.toleranceMm = tolMm;
      activeObj.volumeMode = volMode;
      activeObj.displayMode = QA_STATE.flatnessDisplayMode || "tiles";
      activeObj.showPass3D = showPass;
      activeObj.planeMode = QA_STATE.flatnessPlaneMode || activeObj.planeMode || "best_fit_3d";
      activeObj.resolutionCm = Number(QA_STATE.flatnessCache.resolutionCm || QA_STATE.flatnessResolutionCm || 15);
      activeObj.cache = QA_STATE.flatnessCache;
      activeObj.metrics = metrics;
      activeObj.result = metrics;
      renderSavedFlatnessObjectsMenu();
    }

    renderSurfaceQaResults(metrics);
    renderPolygonFlatness3DOverlay(QA_STATE.flatnessCache, metrics, showPass);
  }

  async function lockFlatnessPolygonAndAnalyze(lockedPtsInput = null, opts = null) {
    // Distinguish editing the currently active saved object (vertex drag, plane mode change, or resolution change)
    // vs. closing a brand-new polygon on the 3D surface
    const isEditingActiveObject = Boolean(
      (opts && opts.updateActiveObject) ||
        (QA_STATE.activeFlatnessObjectId &&
          Array.isArray(lockedPtsInput) &&
          window.STATE &&
          lockedPtsInput === window.STATE.flatnessPolygonPoints)
    );

    const rawPts =
      Array.isArray(lockedPtsInput) && lockedPtsInput.length >= 3
        ? lockedPtsInput
        : window.STATE && Array.isArray(window.STATE.measurePoints)
        ? window.STATE.measurePoints.slice()
        : [];

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
    const resCm = Math.max(
      1,
      Math.min(200, safeFloat(document.getElementById("inpFlatnessResolutionCm")?.value, QA_STATE.flatnessResolutionCm || 15))
    );
    QA_STATE.flatnessResolutionCm = resCm;

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
        cancelToken,
        resCm
      );
      if (cancelToken.cancelled) return;
      QA_STATE.flatnessCancelToken = null;
      QA_STATE.flatnessCache = cache;

      const tolMm = QA_STATE.flatnessToleranceMm || 3.0;
      const volMode = QA_STATE.flatnessVolumeMode || "threshold";
      const metrics = evaluateCachedFlatnessWithTolerance(cache, tolMm, volMode);

      // Save or update in per-scan Saved Flatness Objects list
      const objs = getFlatnessObjectsForActiveScan();
      let savedObj = isEditingActiveObject ? getActiveFlatnessObject() : null;
      const surfaceTitleZh =
        planeMode === "vertical_plumb" || Number(cache.plane?.slopeDeg) > 55
          ? "鉛直牆面"
          : planeMode === "horizontal"
          ? "水平地坪"
          : cache.plane?.surfaceClassZh || "檢測面";

      if (savedObj) {
        savedObj.polyPts = polyPts.map((p) => ({ x: Number(p.x), y: Number(p.y), z: Number(p.z) }));
        savedObj.planeMode = planeMode;
        savedObj.toleranceMm = tolMm;
        savedObj.volumeMode = volMode;
        savedObj.resolutionCm = Number(cache.resolutionCm || resCm);
        savedObj.displayMode = QA_STATE.flatnessDisplayMode || "tiles";
        savedObj.showPass3D = Boolean(QA_STATE.flatnessShowPass3D);
        savedObj.cache = cache;
        savedObj.metrics = metrics;
        savedObj.result = metrics;
        savedObj.name = `${savedObj.code} ${surfaceTitleZh} (${cache.totalAreaM2} m²)`;
      } else {
        const maxNum = objs.reduce((acc, o) => {
          const m = /^F(\d+)$/i.exec(String(o?.code || ""));
          return m ? Math.max(acc, parseInt(m[1], 10)) : acc;
        }, 0);
        const code = `F${maxNum + 1}`;
        const newId = `flat_${getActiveFlatnessScanId()}_${Date.now()}_${QA_STATE.flatnessNextSeq++}`;
        savedObj = {
          id: newId,
          code,
          name: `${code} ${surfaceTitleZh} (${cache.totalAreaM2} m²)`,
          scanId: getActiveFlatnessScanId(),
          visible: true,
          polyPts: polyPts.map((p) => ({ x: Number(p.x), y: Number(p.y), z: Number(p.z) })),
          planeMode,
          toleranceMm: tolMm,
          volumeMode: volMode,
          resolutionCm: Number(cache.resolutionCm || resCm),
          displayMode: QA_STATE.flatnessDisplayMode || "tiles",
          showPass3D: Boolean(QA_STATE.flatnessShowPass3D),
          cache,
          metrics,
          result: metrics,
          createdAt: new Date().toISOString(),
        };
        objs.push(savedObj);
        QA_STATE.activeFlatnessObjectId = savedObj.id;
      }

      if (Number(cache.resolutionCm) > Number(cache.requestedResolutionCm || resCm) + 0.15) {
        QA_STATE.flatnessResolutionCm = Number(cache.resolutionCm);
        const lblRes = document.getElementById("lblFlatnessResReadout");
        if (lblRes) lblRes.textContent = `${cache.resolutionCm} cm`;
        if (typeof showToast === "function") {
          showToast(
            t(
              `檢測範圍較大，網格解析度已自動調整為 ${cache.resolutionCm} cm 以維持流暢度`,
              `Large polygon: grid resolution clamped to ${cache.resolutionCm} cm for performance`
            )
          );
        }
      }

      const progWrap = document.getElementById("flatnessSamplingProgressWrap");
      const badgeState = document.getElementById("badgeFlatnessPolyState");
      if (progWrap) progWrap.style.display = "none";
      if (badgeState) badgeState.textContent = `${savedObj.code} ${t("已儲存", "Saved")}`;
      const lblCount = document.getElementById("lblFlatnessVertexCount");
      if (lblCount) {
        lblCount.textContent = t(
          `已儲存 ${savedObj.code} (${cache.totalAreaM2} m², ${cache.cells.length} 格 @ ${cache.resolutionCm}cm) — 可拖曳頂點或點「新增」框選下一區`,
          `Saved ${savedObj.code} (${cache.totalAreaM2} m², ${cache.cells.length} cells @ ${cache.resolutionCm}cm) — drag pins or click 'New'`
        );
      }
      renderSavedFlatnessObjectsMenu();
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
    document.getElementById("btnNewFlatnessObject")?.addEventListener("click", () => {
      startNewFlatnessObjectDraft(true);
    });

    document.querySelectorAll('input[name="qaRefMode"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        document.querySelectorAll('#surfaceQaContainer input[name="qaRefMode"]').forEach((r) => {
          r.closest(".gs-qa-mode-pill")?.classList.remove("active");
        });
        e.target.closest(".gs-qa-mode-pill")?.classList.add("active");
        QA_STATE.flatnessPlaneMode = e.target.value;
        const pts =
          window.STATE && Array.isArray(window.STATE.flatnessPolygonPoints) && window.STATE.flatnessPolygonPoints.length >= 3
            ? window.STATE.flatnessPolygonPoints
            : QA_STATE.flatnessCache && Array.isArray(QA_STATE.flatnessCache.polyPts)
            ? QA_STATE.flatnessCache.polyPts
            : null;
        if (pts && pts.length >= 3) {
          lockFlatnessPolygonAndAnalyze(pts, { updateActiveObject: true });
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

    const rngRes = document.getElementById("rngFlatnessResolutionCm");
    const inpRes = document.getElementById("inpFlatnessResolutionCm");
    const lblRes = document.getElementById("lblFlatnessResReadout");
    let resTimer = null;
    const triggerResolutionRecompute = (valCm) => {
      const cleanCm = Math.max(1, Math.min(200, safeFloat(valCm, 15)));
      QA_STATE.flatnessResolutionCm = cleanCm;
      if (lblRes) lblRes.textContent = `${cleanCm} cm`;
      if (resTimer) clearTimeout(resTimer);
      resTimer = setTimeout(() => {
        const pts =
          window.STATE && Array.isArray(window.STATE.flatnessPolygonPoints) && window.STATE.flatnessPolygonPoints.length >= 3
            ? window.STATE.flatnessPolygonPoints
            : QA_STATE.flatnessCache && Array.isArray(QA_STATE.flatnessCache.polyPts)
            ? QA_STATE.flatnessCache.polyPts
            : null;
        if (pts && pts.length >= 3) {
          lockFlatnessPolygonAndAnalyze(pts, { updateActiveObject: true });
        }
      }, 90);
    };

    rngRes?.addEventListener("input", (e) => {
      const val = Math.max(2, Math.min(100, safeFloat(e.target.value, 15)));
      if (inpRes) inpRes.value = String(val);
      triggerResolutionRecompute(val);
    });

    inpRes?.addEventListener("change", (e) => {
      const val = Math.max(1, Math.min(200, safeFloat(e.target.value, 15)));
      if (inpRes) inpRes.value = String(val);
      if (rngRes) rngRes.value = String(Math.min(100, Math.max(2, val)));
      triggerResolutionRecompute(val);
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

    document.getElementById("chkFlatnessReportIncludeMaterial")?.addEventListener("change", (e) => {
      QA_STATE.flatnessReportIncludeMaterial = Boolean(e.target.checked);
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
      startNewFlatnessObjectDraft(true);
    });

    document.getElementById("btnExportSurfaceQaCsv")?.addEventListener("click", () => {
      const objs = getFlatnessObjectsForActiveScan();
      if ((!QA_STATE.surfaceQaLastResult || !QA_STATE.flatnessCache) && objs.length === 0) {
        if (typeof showToast === "function") showToast(t("請先框選多邊形執行分析", "Draw and analyze a polygon first"));
        return;
      }
      exportSurfaceQaCsv(QA_STATE.surfaceQaLastResult, QA_STATE.flatnessCache);
    });

    document.getElementById("btnExportFlatnessReport")?.addEventListener("click", () => {
      const objs = getFlatnessObjectsForActiveScan();
      if ((!QA_STATE.surfaceQaLastResult || !QA_STATE.flatnessCache) && objs.length === 0) {
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
    const activeObj = getActiveFlatnessObject();
    const regionTag = activeObj ? `${activeObj.code} · ` : "";

    card.innerHTML = `
      <!-- Pass Rate & Area Summary Banner -->
      <div class="gs-qa-grade-box ${badgeCls}">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:10px;text-transform:uppercase;color:var(--ui-text-muted);">
              ${regionTag}${t("合格率", "Pass Rate")} (+/-${res.tolerance_mm} mm)
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
    const objs = getFlatnessObjectsForActiveScan();
    const exportList = objs.length > 0 ? objs : (res && cache ? [{
      code: "F1",
      name: t("檢測區 #1", "Region #1"),
      planeMode: res.reference_mode,
      toleranceMm: res.tolerance_mm,
      volumeMode: res.volume_mode,
      resolutionCm: res.resolution_cm || QA_STATE.flatnessResolutionCm || 15,
      result: res,
      cache: cache,
    }] : []);
    if (exportList.length === 0) return;

    const scanId = (exportList[0].result && exportList[0].result.scan_id) || (res && res.scan_id) || "scan";
    const lines = [
      `# GatheringScans Multi-Region 3D Surface Flatness & Construction QA Inspection Data`,
      `# Scan ID: ${scanId} | CRS: EPSG:3826 (TWD97 TM2) + TWVD2001 | Regions Count: ${exportList.length}`,
      `Object_Code,Object_Name,Plane_Mode,Tolerance_mm,Resolution_cm,Cell_Index,Easting_m,Northing_m,Elevation_m,Deviation_mm,CellArea_m2,Status`,
    ];
    exportList.forEach((obj) => {
      const r = obj.result || {};
      const c = obj.cache || {};
      const pts = Array.isArray(c.cells) ? c.cells : [];
      pts.forEach((p, i) => {
        lines.push(
          `${obj.code || "F1"},"${String(obj.name || "").replace(/"/g, '""')}",${r.reference_mode || obj.planeMode},${r.tolerance_mm || obj.toleranceMm},${r.resolution_cm || obj.resolutionCm || 15},${i + 1},${p.e},${p.n},${p.h},${Number(p.devMm || 0).toFixed(2)},${Number(c.cellAreaM2 || 0).toFixed(4)},${String(p.status || "pass").toUpperCase()}`
        );
      });
    });
    downloadBlob("\uFEFF" + lines.join("\r\n"), `flatness_takeoff_${scanId}.csv`, "text/csv;charset=utf-8;");
  }

  /**
   * Captures a Site-Wide Top-Down Overview Screenshot (with Plumb Wall callout leader arrows)
   * plus per-object 3D Perspective & Plane-Normal Orthographic Deviation Screenshots,
   * and opens a formal printable A4 Engineering Quality Inspection Report.
   */
  function exportFlatnessReportWithScreenshots(res, cache) {
    if (!window.studioThree || !window.studioThree.renderer || !window.studioThree.scene || !window.studioThree.camera) {
      if (typeof showToast === "function") showToast(t("3D 視圖尚未就緒", "3D viewport not ready"));
      return;
    }
    const { renderer, scene, camera, controls } = window.studioThree;
    const THREE = window.THREE;

    const savedObjs = getFlatnessObjectsForActiveScan();
    const reportObjs = savedObjs.length > 0 ? savedObjs : (res && cache ? [{
      id: "flat_obj_temp",
      code: "F1",
      name: t("檢測區 #1", "Region #1"),
      planeMode: res.reference_mode || QA_STATE.surfacePlaneMode || "best_fit_3d",
      toleranceMm: res.tolerance_mm || QA_STATE.surfaceToleranceMm || 3.0,
      volumeMode: res.volume_mode || QA_STATE.flatnessVolumeMode || "threshold",
      resolutionCm: res.resolution_cm || QA_STATE.flatnessResolutionCm || 15,
      visible: true,
      polyPts: Array.isArray(cache.polyPts) ? cache.polyPts : [],
      cache,
      result: res,
    }] : []);
    if (reportObjs.length === 0) return;

    const prevVisStates = reportObjs.map((o) => o.visible !== false);
    reportObjs.forEach((o) => { o.visible = true; });
    renderPolygonFlatness3DOverlay(cache || (reportObjs[0] && reportObjs[0].cache));

    const savedPos = camera.position.clone();
    const savedQuat = camera.quaternion.clone();
    const savedUp = camera.up.clone();
    const savedTarget = controls ? controls.target.clone() : new THREE.Vector3();

    // 1. Capture Site-Wide Top-Down Plan Overview of ALL flatness objects
    let globalMinX = Infinity, globalMaxX = -Infinity;
    let globalMinY = Infinity, globalMaxY = -Infinity;
    let globalMinZ = Infinity, globalMaxZ = -Infinity;
    reportObjs.forEach((obj) => {
      const pts = Array.isArray(obj.polyPts) && obj.polyPts.length > 0 ? obj.polyPts : (obj.cache && obj.cache.polyPts) || [];
      pts.forEach((p) => {
        if (p.x < globalMinX) globalMinX = p.x;
        if (p.x > globalMaxX) globalMaxX = p.x;
        if (p.y < globalMinY) globalMinY = p.y;
        if (p.y > globalMaxY) globalMaxY = p.y;
        if (p.z < globalMinZ) globalMinZ = p.z;
        if (p.z > globalMaxZ) globalMaxZ = p.z;
      });
    });
    if (!Number.isFinite(globalMinX)) {
      globalMinX = -5; globalMaxX = 5;
      globalMinY = -2; globalMaxY = 2;
      globalMinZ = -5; globalMaxZ = 5;
    }
    const cx = (globalMinX + globalMaxX) * 0.5;
    const cy = (globalMinY + globalMaxY) * 0.5;
    const cz = (globalMinZ + globalMaxZ) * 0.5;
    const spanXZ = Math.max(globalMaxX - globalMinX, globalMaxZ - globalMinZ, 6.0);
    const topDownDist = Math.max(spanXZ * 1.35, (globalMaxY - globalMinY) + 8.0);

    camera.position.set(cx, globalMaxY + topDownDist, cz);
    camera.up.set(0, 0, -1);
    camera.lookAt(new THREE.Vector3(cx, cy, cz));
    camera.updateMatrixWorld(true);
    renderer.render(scene, camera);

    const srcCvs = renderer.domElement;
    const ovCvs = document.createElement("canvas");
    ovCvs.width = srcCvs.width;
    ovCvs.height = srcCvs.height;
    const octx = ovCvs.getContext("2d");
    octx.drawImage(srcCvs, 0, 0);

    octx.fillStyle = "rgba(15, 23, 42, 0.90)";
    octx.fillRect(16, 16, 420, 56);
    octx.strokeStyle = "#cbd5e1";
    octx.lineWidth = 1.5;
    octx.strokeRect(16, 16, 420, 56);
    octx.fillStyle = "#f8fafc";
    octx.font = "bold 14px 'Microsoft JhengHei', sans-serif";
    octx.fillText(`全區俯視正射配置總覽圖 (Site-Wide Top-Down Plan Overview)`, 28, 38);
    octx.fillStyle = "#cbd5e1";
    octx.font = "12px 'Microsoft JhengHei', sans-serif";
    octx.fillText(`共 ${reportObjs.length} 處檢驗分區 ｜ 垂直牆面以引線箭頭 (──►) 標示平面位置`, 28, 58);

    const placedWallBoxes = [];
    reportObjs.forEach((obj, objIdx) => {
      const c = obj.cache || {};
      const r = obj.result || {};
      const pts = Array.isArray(obj.polyPts) && obj.polyPts.length > 0 ? obj.polyPts : (c.polyPts || []);
      if (pts.length === 0) return;

      const screenPts = pts.map((pt) => {
        const v = new THREE.Vector3(pt.x, pt.y, pt.z).project(camera);
        return { x: (v.x * 0.5 + 0.5) * ovCvs.width, y: (-v.y * 0.5 + 0.5) * ovCvs.height };
      });
      const pc = (c.plane && c.plane.center) || pts[0];
      const vc = new THREE.Vector3(pc.x, pc.y, pc.z).project(camera);
      const scx = (vc.x * 0.5 + 0.5) * ovCvs.width;
      const scy = (-vc.y * 0.5 + 0.5) * ovCvs.height;

      const isWall = obj.planeMode === "vertical_plumb" || (r.plumb_tilt && Number(r.plumb_tilt.slope_deg) > 55);

      octx.save();
      octx.strokeStyle = isWall ? "#f59e0b" : "#38bdf8";
      octx.lineWidth = isWall ? 3.0 : 2.2;
      octx.setLineDash(isWall ? [6, 3] : []);
      octx.beginPath();
      screenPts.forEach((sp, i) => {
        if (i === 0) octx.moveTo(sp.x, sp.y);
        else octx.lineTo(sp.x, sp.y);
      });
      octx.closePath();
      octx.stroke();
      octx.restore();

      if (isWall) {
        const boxW = 230, boxH = 44;
        const offsetDirX = scx > ovCvs.width * 0.55 ? -1 : 1;
        const offsetDirY = scy > ovCvs.height * 0.55 ? -1 : 1;
        const tailX = Math.max(140, Math.min(ovCvs.width - 240, scx + offsetDirX * 115));
        let tailY = Math.max(95, Math.min(ovCvs.height - 55, scy + offsetDirY * (68 + (objIdx % 4) * 26)));
        let boxX = offsetDirX < 0 ? tailX - boxW : tailX;
        let boxY = tailY - boxH * 0.5;
        for (let iter = 0; iter < 8; iter++) {
          const hit = placedWallBoxes.find((b) => Math.abs(boxX - b.x) < boxW + 6 && Math.abs(boxY - b.y) < boxH + 6);
          if (!hit) break;
          boxY = hit.y + boxH + 8 <= ovCvs.height - boxH - 10 ? hit.y + boxH + 8 : Math.max(82, hit.y - boxH - 8);
          tailY = boxY + boxH * 0.5;
        }
        placedWallBoxes.push({ x: boxX, y: boxY });

        octx.save();
        octx.strokeStyle = "#f59e0b";
        octx.fillStyle = "#f59e0b";
        octx.lineWidth = 2.8;
        octx.beginPath();
        octx.moveTo(tailX, tailY);
        octx.lineTo(scx, scy);
        octx.stroke();

        const ang = Math.atan2(scy - tailY, scx - tailX);
        const headLen = 13;
        octx.beginPath();
        octx.moveTo(scx, scy);
        octx.lineTo(scx - headLen * Math.cos(ang - Math.PI / 6), scy - headLen * Math.sin(ang - Math.PI / 6));
        octx.lineTo(scx - headLen * Math.cos(ang + Math.PI / 6), scy - headLen * Math.sin(ang + Math.PI / 6));
        octx.closePath();
        octx.fill();

        octx.beginPath();
        octx.arc(scx, scy, 6, 0, Math.PI * 2);
        octx.fillStyle = "#dc2626";
        octx.fill();
        octx.strokeStyle = "#ffffff";
        octx.lineWidth = 2;
        octx.stroke();

        octx.fillStyle = "rgba(15, 23, 42, 0.94)";
        octx.fillRect(boxX, boxY, boxW, boxH);
        octx.strokeStyle = "#f59e0b";
        octx.lineWidth = 2;
        octx.strokeRect(boxX, boxY, boxW, boxH);
        octx.fillStyle = "#fbbf24";
        octx.font = "bold 12.5px 'Microsoft JhengHei', sans-serif";
        octx.fillText(`[牆面垂直度檢驗] ${obj.code || `F${objIdx + 1}`} ${obj.name || ""}`, boxX + 8, boxY + 18);
        octx.fillStyle = "#f8fafc";
        octx.font = "11.5px 'Microsoft JhengHei', sans-serif";
        octx.fillText(`傾角 ${r.plumb_tilt?.plumb_mm_per_m || 0} mm/m ｜ 合格率 ${r.pass_rate_pct || 0}%`, boxX + 8, boxY + 35);
        octx.restore();
      } else {
        const tagTxt = `${obj.code || `F${objIdx + 1}`} (${r.pass_rate_pct || 0}%)`;
        octx.save();
        octx.font = "bold 12px 'Microsoft JhengHei', sans-serif";
        const tw = octx.measureText(tagTxt).width + 14;
        octx.fillStyle = "rgba(15, 23, 42, 0.88)";
        octx.fillRect(scx - tw * 0.5, scy - 12, tw, 24);
        octx.strokeStyle = "#38bdf8";
        octx.lineWidth = 1.5;
        octx.strokeRect(scx - tw * 0.5, scy - 12, tw, 24);
        octx.fillStyle = "#f8fafc";
        octx.fillText(tagTxt, scx - tw * 0.5 + 7, scy + 4);
        octx.restore();
      }
    });
    const figOverviewDataUrl = ovCvs.toDataURL("image/png");

    // 2. Capture Per-Object Screenshots (3D Oblique Perspective + Plane-Normal Orthographic Deviation Map)
    const objectSnapshots = reportObjs.map((obj, idx) => {
      const c = obj.cache || cache;
      const r = obj.result || res;
      const p = c.plane;
      const fc = new THREE.Vector3(p.center.x, p.center.y, p.center.z);
      const fn = new THREE.Vector3(p.normal.x, p.normal.y, p.normal.z).normalize();
      const fu = new THREE.Vector3(p.uAxis.x, p.uAxis.y, p.uAxis.z).normalize();
      const fv = new THREE.Vector3(p.vAxis.x, p.vAxis.y, p.vAxis.z).normalize();
      const maxSpan = Math.max(c.spanU || 4, c.spanV || 4, 3.0);
      const camDist = maxSpan * 1.45;

      // 2A: Oblique 3D Perspective view focused on this flatness object
      const perspPos = fc.clone()
        .addScaledVector(fn, camDist * 0.88)
        .addScaledVector(fu, maxSpan * 0.52)
        .addScaledVector(fv, -maxSpan * 0.42);
      camera.position.copy(perspPos);
      camera.up.set(0, 1, 0);
      camera.lookAt(fc);
      camera.updateMatrixWorld(true);
      renderer.render(scene, camera);
      const fig1DataUrl = renderer.domElement.toDataURL("image/png");

      // 2B: Plane-Normal Orthographic Deviation Map with V1..Vn & Legend
      camera.position.copy(fc).addScaledVector(fn, camDist);
      camera.up.copy(fv);
      camera.lookAt(fc);
      camera.updateMatrixWorld(true);
      renderer.render(scene, camera);

      const outCvs = document.createElement("canvas");
      outCvs.width = srcCvs.width;
      outCvs.height = srcCvs.height;
      const ctx = outCvs.getContext("2d");
      ctx.drawImage(srcCvs, 0, 0);

      const polyPts = Array.isArray(obj.polyPts) && obj.polyPts.length > 0 ? obj.polyPts : (c.polyPts || []);
      if (polyPts.length > 0) {
        ctx.font = "bold 13px 'Microsoft JhengHei', sans-serif";
        polyPts.forEach((pt, vIdx) => {
          const v = new THREE.Vector3(pt.x, pt.y, pt.z).project(camera);
          const sx = (v.x * 0.5 + 0.5) * outCvs.width;
          const sy = (-v.y * 0.5 + 0.5) * outCvs.height;
          ctx.fillStyle = vIdx === 0 ? "#dc2626" : "#0284c7";
          ctx.beginPath();
          ctx.arc(sx, sy, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#ffffff";
          ctx.fillText(`V${vIdx + 1}`, sx + 9, sy + 4);
        });
      }

      ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
      ctx.fillRect(18, 18, 310, 92);
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(18, 18, 310, 92);
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 13px 'Microsoft JhengHei', sans-serif";
      ctx.fillText(`${obj.code || `F${idx + 1}`} 平面正射高低差分佈圖 (公差 ±${r.tolerance_mm} mm)`, 30, 40);
      ctx.fillStyle = "#dc2626";
      ctx.fillRect(30, 52, 14, 14);
      ctx.fillStyle = "#f8fafc";
      ctx.font = "12px 'Microsoft JhengHei', sans-serif";
      ctx.fillText(`凸起超差 (> +${r.tolerance_mm}mm): 面積 ${r.high_area_m2} m² (${r.high_area_pct}%)`, 52, 63);
      ctx.fillStyle = "#2563eb";
      ctx.fillRect(30, 74, 14, 14);
      ctx.fillStyle = "#f8fafc";
      ctx.fillText(`凹陷超差 (< -${r.tolerance_mm}mm): 面積 ${r.low_area_m2} m² (${r.low_area_pct}%)`, 52, 85);
      const fig2DataUrl = outCvs.toDataURL("image/png");

      return { obj, r, c, fig1DataUrl, fig2DataUrl };
    });

    // Restore object visibility states and camera immediately
    reportObjs.forEach((o, i) => { o.visible = prevVisStates[i]; });
    renderPolygonFlatness3DOverlay(cache || (reportObjs[0] && reportObjs[0].cache));
    camera.position.copy(savedPos);
    camera.quaternion.copy(savedQuat);
    camera.up.copy(savedUp);
    if (controls) {
      controls.target.copy(savedTarget);
      controls.update();
    }
    renderer.render(scene, camera);

    const nowStr = new Date().toISOString().slice(0, 19).replace("T", " ");
    const scanId = (res && res.scan_id) || (reportObjs[0].result && reportObjs[0].result.scan_id) || "scan";
    const includeMat = Boolean(QA_STATE.flatnessReportIncludeMaterial);

    let totalAreaAll = 0;
    let totalWeightedPass = 0;
    let totalExcessL = 0;
    let totalLackingL = 0;
    let totalBags = 0;
    objectSnapshots.forEach(({ r }) => {
      const a = Number(r.total_area_m2 || 0);
      totalAreaAll += a;
      totalWeightedPass += a * Number(r.pass_rate_pct || 0);
      totalExcessL += Number(r.excess_volume_liters || 0);
      totalLackingL += Number(r.lacking_volume_liters || 0);
      totalBags += Number(r.est_mortar_bags_25kg || 0);
    });
    const avgPassRate = totalAreaAll > 0 ? Number((totalWeightedPass / totalAreaAll).toFixed(1)) : (res?.pass_rate_pct || 0);
    const totalNetL = Number((totalLackingL - totalExcessL).toFixed(2));

    const summaryRowsHtml = objectSnapshots.map(({ obj, r, c }, idx) => {
      const modeZh = r.reference_mode === "horizontal"
        ? "水平高程面 (0° 標高)"
        : r.reference_mode === "vertical_plumb"
        ? "垂直牆面鉛垂面 (90°)"
        : "最佳擬合平面 (3D PCA)";
      const isPass = Number(r.pass_rate_pct || 0) >= 85.0;
      const statusText = isPass ? "合格 (符合允收標準)" : Number(r.pass_rate_pct || 0) >= 70.0 ? "尚可 (局部待整修)" : "不合格 (須優先整修)";
      const statusColor = isPass ? "#15803d" : Number(r.pass_rate_pct || 0) >= 70.0 ? "#b45309" : "#b91c1c";
      return `
        <tr>
          <td style="text-align:center;font-weight:700;">${obj.code || `F${idx + 1}`}</td>
          <td><b>${obj.name || `檢驗區 #${idx + 1}`}</b><br/><span style="font-size:11px;color:#475569;">${modeZh} · 網格 ${r.resolution_cm || obj.resolutionCm || 15} cm</span></td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;">±${r.tolerance_mm} mm</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;">${r.total_area_m2} m²</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:700;">${r.pass_rate_pct}%</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;">${r.rms_dev_mm} mm</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;color:#b91c1c;">+${r.max_high?.dev_mm || 0} / ${r.max_low?.dev_mm || 0} mm</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;">${r.plumb_tilt?.slope_deg || 0}° (${r.plumb_tilt?.plumb_mm_per_m || 0} mm/m)</td>
          <td class="mat-calc-col" style="text-align:right;font-variant-numeric:tabular-nums;">${r.excess_volume_liters} L / ${r.lacking_volume_liters} L</td>
          <td class="mat-calc-col" style="text-align:right;font-variant-numeric:tabular-nums;">${r.est_mortar_bags_25kg || 0} 包</td>
          <td style="color:${statusColor};font-weight:700;">${statusText}</td>
        </tr>
      `;
    }).join("");

    const detailSectionsHtml = objectSnapshots.map(({ obj, r, c, fig1DataUrl, fig2DataUrl }, idx) => {
      const spec = getFlatnessRegulationSpec(r.tolerance_mm);
      const astm = r.astm_e1155 || {};
      const plumb = r.plumb_tilt || {};
      const passArea = Number(Math.max(0, (r.total_area_m2 || 0) - (r.high_area_m2 || 0) - (r.low_area_m2 || 0))).toFixed(2);
      const isWall = obj.planeMode === "vertical_plumb" || Number(plumb.slope_deg) > 55;
      return `
        <div class="section-block">
          <div class="section-header">
            <span>檢驗分區明細 [${obj.code || `F${idx + 1}`}]：${obj.name || `檢驗區 #${idx + 1}`} ${isWall ? "（垂直牆面鉛垂檢驗區）" : ""}</span>
            <span>依據規範：${spec.clause}（容許公差 ±${r.tolerance_mm} mm）</span>
          </div>
          <table>
            <thead>
              <tr>
                <th style="width:24%;">檢驗分項</th>
                <th style="width:16%;">涵蓋面積 (m² / 比例)</th>
                <th style="width:16%;">極值 / 均方根偏差</th>
                <th style="width:18%;">幾何與平整度指標</th>
                <th class="mat-calc-col" style="width:14%;">超差體積 (L / m³)</th>
                <th>工程處置與施工建議</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><b>凸起超差區域 (&gt; +${r.tolerance_mm} mm)</b></td>
                <td style="font-variant-numeric:tabular-nums;">${r.high_area_m2} m² (${r.high_area_pct}%)</td>
                <td style="color:#b91c1c;font-weight:700;font-variant-numeric:tabular-nums;">最大凸起 +${r.max_high?.dev_mm || 0} mm</td>
                <td>高程中位數 ${c.plane ? Number(c.plane.medH || 0).toFixed(3) : "—"} m</td>
                <td class="mat-calc-col" style="font-variant-numeric:tabular-nums;"><b>${r.excess_volume_liters} L</b> (${r.excess_volume_m3} m³)</td>
                <td>局部高點以無塵混凝土研磨機打磨或銑刨整平</td>
              </tr>
              <tr>
                <td><b>凹陷超差區域 (&lt; -${r.tolerance_mm} mm)</b></td>
                <td style="font-variant-numeric:tabular-nums;">${r.low_area_m2} m² (${r.low_area_pct}%)</td>
                <td style="color:#1d4ed8;font-weight:700;font-variant-numeric:tabular-nums;">最大凹陷 ${r.max_low?.dev_mm || 0} mm</td>
                <td>傾角 ${plumb.slope_deg || 0}° (${plumb.plumb_mm_per_m || 0} mm/m)</td>
                <td class="mat-calc-col" style="font-variant-numeric:tabular-nums;"><b>${r.lacking_volume_liters} L</b> (${r.lacking_volume_m3} m³)</td>
                <td>以無收縮水泥砂漿、環氧樹脂砂漿或自平泥填補整平<span class="mat-calc-block">（約 ${r.est_mortar_bags_25kg} 包 25kg 乾拌料）</span></td>
              </tr>
              <tr>
                <td><b>合格允收範圍 (|偏差| &le; ${r.tolerance_mm} mm)</b></td>
                <td style="font-variant-numeric:tabular-nums;">${passArea} m² (${r.pass_rate_pct}%)</td>
                <td style="font-variant-numeric:tabular-nums;">RMS ${r.rms_dev_mm} mm (平均 ${r.mean_abs_dev_mm} mm)</td>
                <td>ASTM E1155: F<sub>F</sub> ${astm.ff_flatness || "—"} / F<sub>L</sub> ${astm.fl_levelness || "—"}</td>
                <td class="mat-calc-col" style="font-variant-numeric:tabular-nums;">0.00 L (0.0000 m³)</td>
                <td>符合公共工程施工綱要規範容許公差標準</td>
              </tr>
            </tbody>
          </table>
          <div class="figs">
            <div class="fig-card">
              <img src="${fig1DataUrl}" alt="${obj.code} 3D Perspective View" />
              <div class="fig-cap">圖 ${idx + 1}-A（${obj.code}）：三維點雲與擬合基準面透視檢視圖（網格解析度 ${r.resolution_cm || obj.resolutionCm || 15} cm × ${r.resolution_cm || obj.resolutionCm || 15} cm）</div>
            </div>
            <div class="fig-card">
              <img src="${fig2DataUrl}" alt="${obj.code} Orthographic Deviation Map" />
              <div class="fig-cap">圖 ${idx + 1}-B（${obj.code}）：基準面法線正射投影偏差分佈圖（含控制頂點 V1..Vn 與色階圖例）</div>
            </div>
          </div>
        </div>
      `;
    }).join("");

    const reportHtml = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <title>工程施工品質自主檢查與三維點雲檢驗報告 - ${scanId}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: "Noto Serif TC", "PMingLiU", "Microsoft JhengHei", "Noto Sans TC", sans-serif;
      color: #0f172a;
      background: #ffffff;
      margin: 20px 28px;
      line-height: 1.55;
      font-size: 12.5px;
    }
    body.hide-material .mat-calc-col,
    body.hide-material .mat-calc-block {
      display: none !important;
    }
    .doc-header {
      border-bottom: 2px solid #1e293b;
      padding-bottom: 10px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    h1 {
      font-size: 19px;
      font-weight: 700;
      margin: 0;
      color: #0f172a;
      letter-spacing: 0.5px;
    }
    .doc-subtitle {
      font-size: 11.5px;
      color: #334155;
      margin-top: 3px;
    }
    .meta-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 14px;
      font-size: 11.5px;
    }
    .meta-table th, .meta-table td {
      border: 1px solid #94a3b8;
      padding: 5px 8px;
    }
    .meta-table th {
      background: #f1f5f9;
      color: #1e293b;
      width: 13%;
      text-align: left;
      font-weight: 700;
    }
    .meta-table td {
      width: 20%;
      color: #0f172a;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
      gap: 8px;
      margin-bottom: 14px;
    }
    .kpi-box {
      border: 1px solid #94a3b8;
      padding: 8px 10px;
      background: #f8fafc;
    }
    .kpi-label {
      font-size: 11px;
      color: #475569;
      font-weight: 600;
    }
    .kpi-val {
      font-size: 16px;
      font-weight: 700;
      margin-top: 2px;
      color: #0f172a;
      font-variant-numeric: tabular-nums;
    }
    .section-title {
      font-size: 13.5px;
      font-weight: 700;
      color: #0f172a;
      background: #e2e8f0;
      border: 1px solid #94a3b8;
      border-bottom: none;
      padding: 6px 10px;
      margin-top: 14px;
    }
    .section-block {
      margin-top: 16px;
      page-break-inside: avoid;
    }
    .section-header {
      background: #f1f5f9;
      border: 1px solid #94a3b8;
      border-bottom: none;
      padding: 6px 10px;
      font-size: 12.5px;
      font-weight: 700;
      display: flex;
      justify-content: space-between;
      color: #0f172a;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 12px;
      font-size: 11.5px;
    }
    th, td {
      border: 1px solid #94a3b8;
      padding: 6px 8px;
      text-align: left;
      vertical-align: middle;
    }
    th {
      background: #f8fafc;
      color: #1e293b;
      font-weight: 700;
    }
    .overview-fig {
      border: 1px solid #94a3b8;
      padding: 8px;
      background: #ffffff;
      margin-bottom: 14px;
    }
    .overview-fig img {
      width: 100%;
      max-height: 360px;
      object-fit: contain;
      display: block;
      background: #0f172a;
    }
    .figs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 14px;
    }
    .fig-card {
      border: 1px solid #94a3b8;
      padding: 6px;
      background: #ffffff;
    }
    .fig-card img {
      width: 100%;
      height: auto;
      display: block;
    }
    .fig-cap {
      font-size: 11px;
      font-weight: 700;
      color: #1e293b;
      margin-top: 5px;
      text-align: center;
    }
    .norm-box {
      border: 1px solid #94a3b8;
      background: #f8fafc;
      padding: 8px 12px;
      font-size: 11px;
      color: #1e293b;
      margin-top: 14px;
    }
    .norm-box a {
      color: #0369a1;
      text-decoration: underline;
    }
    .sign-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-top: 18px;
      page-break-inside: avoid;
    }
    .sign-box {
      border: 1px solid #64748b;
      padding: 8px 10px;
      height: 76px;
      font-size: 11.5px;
      color: #1e293b;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    @media print {
      .no-print { display: none !important; }
      body { margin: 10mm; }
    }
  </style>
</head>
<body class="${includeMat ? "" : "hide-material"}">
  <div class="no-print" style="margin-bottom:12px;padding:8px 12px;background:#f1f5f9;border:1px solid #cbd5e1;display:flex;justify-content:space-between;align-items:center;">
    <label style="font-size:12px;font-weight:700;color:#1e293b;cursor:pointer;display:flex;align-items:center;gap:6px;">
      <input type="checkbox" id="chkReportToggleMaterial" ${includeMat ? "checked" : ""} onchange="document.body.classList.toggle('hide-material', !this.checked)" />
      顯示材料體積與砂漿包數估算欄位 (Show Material Volume &amp; Mortar Bag Calculations)
    </label>
    <button onclick="window.print()" style="padding:6px 14px;background:#1e293b;color:#ffffff;border:1px solid #0f172a;font-weight:700;cursor:pointer;">列印或另存正式 PDF 報告 (Print / Save PDF)</button>
  </div>

  <div class="doc-header">
    <div>
      <h1>工程施工品質自主檢查與三維點雲表面平整度檢驗報告</h1>
      <div class="doc-subtitle">3D Point Cloud Surface Flatness, Plumbness &amp; Dimensional Quality Control Inspection Report</div>
    </div>
    <div style="text-align:right;font-size:11px;color:#334155;">
      <div>表單編號：GS-QC-FLAT-${scanId.slice(0, 12)}</div>
      <div>產製時間：${nowStr}</div>
    </div>
  </div>

  <table class="meta-table">
    <tbody>
      <tr>
        <th>掃描案號 / 標的</th>
        <td><b>${scanId}</b></td>
        <th>平面與高程基準</th>
        <td><b>EPSG:3826 (TWD97 TM2) + TWVD2001</b></td>
        <th>檢驗分區數量</th>
        <td><b>共 ${objectSnapshots.length} 處檢驗區</b>（最高精度點雲葉節點採樣）</td>
      </tr>
      <tr>
        <th>全區檢驗總面積</th>
        <td><b>${totalAreaAll.toFixed(2)} m²</b></td>
        <th>全區面積加權合格率</th>
        <td><b>${avgPassRate}%</b></td>
        <th>檢驗方法標準</th>
        <td>行政院公共工程委員會《施工綱要規範》及 ASTM E1155</td>
      </tr>
    </tbody>
  </table>

  <div class="kpi-grid">
    <div class="kpi-box">
      <div class="kpi-label">檢驗分區數 ／ 總檢驗面積</div>
      <div class="kpi-val">${objectSnapshots.length} 區 ／ ${totalAreaAll.toFixed(2)} m²</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">全區面積加權合格率</div>
      <div class="kpi-val">${avgPassRate}%</div>
    </div>
    <div class="kpi-box mat-calc-block">
      <div class="kpi-label">凸起超差總體積 (需打磨剔除)</div>
      <div class="kpi-val" style="color:#b91c1c;">${totalExcessL.toFixed(2)} L (${(totalExcessL / 1000).toFixed(4)} m³)</div>
    </div>
    <div class="kpi-box mat-calc-block">
      <div class="kpi-label">凹陷超差總體積 ／ 預估 25kg 砂漿</div>
      <div class="kpi-val" style="color:#1d4ed8;">${totalLackingL.toFixed(2)} L ／ 約 ${totalBags} 包</div>
    </div>
  </div>

  <div class="section-title">壹、全區俯視正射配置總覽圖（含垂直牆面位置引線標示）</div>
  <div class="overview-fig">
    <img src="${figOverviewDataUrl}" alt="Site-Wide Top-Down Plan Overview" />
    <div class="fig-cap">圖 0：全區檢驗分區俯視正射配置總覽圖（共 ${objectSnapshots.length} 處檢驗區；垂直牆面因俯視投影呈線狀，以橘色引線箭頭 ──► 標示其平面座標位置與垂直度）</div>
  </div>

  <div class="section-title">貳、各檢驗分區平整度與幾何精度總表</div>
  <table>
    <thead>
      <tr>
        <th style="width:6%;text-align:center;">代號</th>
        <th style="width:18%;">檢驗分區名稱 ／ 基準模式</th>
        <th style="width:8%;text-align:right;">容許公差</th>
        <th style="width:9%;text-align:right;">檢驗面積</th>
        <th style="width:8%;text-align:right;">合格率</th>
        <th style="width:8%;text-align:right;">RMS 偏差</th>
        <th style="width:12%;text-align:right;">最大凸起 / 凹陷</th>
        <th style="width:11%;text-align:right;">坡度 / 傾角</th>
        <th class="mat-calc-col" style="width:10%;text-align:right;">凸起 / 凹陷體積</th>
        <th class="mat-calc-col" style="width:6%;text-align:right;">砂漿包數</th>
        <th style="width:10%;">判定結果</th>
      </tr>
    </thead>
    <tbody>
      ${summaryRowsHtml}
    </tbody>
  </table>

  <div class="section-title">參、各檢驗分區三維點雲透視圖、法線正射偏差圖與檢驗明細</div>
  ${detailSectionsHtml}

  <div class="norm-box">
    <div style="font-weight:700;margin-bottom:4px;">肆、工程檢驗引用規範與標準條文連結（點擊開啟官方規範說明）：</div>
    <ol style="margin:0;padding-left:18px;line-height:1.65;">
      <li>
        <b>行政院公共工程委員會《公共工程施工綱要規範》第 09611 章「整體粉光地坪」</b>：表面平整度以 3 m 直規檢測，精細整體粉光地坪及建築裝修完成面許可差不得大於 ±3 mm。
        ［<a href="https://pcces.pcc.gov.tw/" target="_blank" rel="noopener noreferrer">公共工程技術資料庫 PCCES 官方規範查詢</a>］
      </li>
      <li>
        <b>行政院公共工程委員會《公共工程施工綱要規範》第 09220 章「水泥砂漿粉刷」</b>：牆面與平頂一般粉刷完成面平整度及垂直度許可差為 ±5 mm。
        ［<a href="https://pcces.pcc.gov.tw/" target="_blank" rel="noopener noreferrer">公共工程技術資料庫 PCCES 官方規範查詢</a>］
      </li>
      <li>
        <b>行政院公共工程委員會《公共工程施工綱要規範》第 03310 章「結構用混凝土」及第 02742 章「瀝青混凝土鋪面及基層」</b>：結構體模板拆模面許可差為 ±10 mm；道路路基、級配粒料基層及整地高程許可差為 ±20 mm。
        ［<a href="https://pcces.pcc.gov.tw/" target="_blank" rel="noopener noreferrer">公共工程技術資料庫 PCCES 官方規範查詢</a>］
      </li>
      <li>
        <b>ASTM E1155《Standard Test Method for Determining F<sub>F</sub> Floor Flatness and F<sub>L</sub> Floor Levelness Numbers》</b>：以 300 mm 步距採樣曲率變化量（q<sub>i</sub>）與 3 m 高程差（z<sub>i</sub>）計算地坪平坦度指標 F<sub>F</sub> 與水平度指標 F<sub>L</sub>。
        ［<a href="https://www.astm.org/e1155-20.html" target="_blank" rel="noopener noreferrer">ASTM International E1155 標準條文連結</a>］
      </li>
      <li>
        <b>內政部國土測繪中心《TWD97 國家坐標系統 (EPSG:3826) 與 TWVD2001 臺灣高程基準》</b>：三維點雲空間坐標與正高轉換基準。
        ［<a href="https://www.nlsc.gov.tw/" target="_blank" rel="noopener noreferrer">內政部國土測繪中心官方規範連結</a>］
      </li>
    </ol>
  </div>

  <div class="sign-grid">
    <div class="sign-box">
      <div><b>測量與三維掃描工程師簽章：</b></div>
      <div style="font-size:10.5px;color:#64748b;">日期：　　年　　月　　日</div>
    </div>
    <div class="sign-box">
      <div><b>施工廠商現場品管人員 (QC) 簽章：</b></div>
      <div style="font-size:10.5px;color:#64748b;">日期：　　年　　月　　日</div>
    </div>
    <div class="sign-box">
      <div><b>監造單位／主辦機關查驗簽章：</b></div>
      <div style="font-size:10.5px;color:#64748b;">日期：　　年　　月　　日</div>
    </div>
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
      downloadBlob(reportHtml, `flatness_qa_report_${scanId}.html`, "text/html;charset=utf-8;");
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
        ${typeof window.renderSurveyToolExplanationBannerHtml === "function" ? window.renderSurveyToolExplanationBannerHtml(
          "明挖管溝 3D 竣工實測",
          "Open-Trench Utility 3D As-Built Tracer",
          "於管溝回填前在 3D 模型連續拾取管底/管頂節點，自動檢核各段流水坡度與規定覆土深度，並匯出 3D DXF/CSV 竣工圖資。",
          "Pick trench invert or crown points in 3D before backfill to verify pipe slope gradients and minimum cover depth, exporting 3D DXF and CSV as-built records."
        ) : ""}
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
    const curMode = QA_STATE.stakeoutSourceMode || "custom";

    const html = `
      <div class="gs-qa-container" id="rtkStakeoutContainer">
        ${typeof window.renderSurveyContainerSubtabsHtml === "function" ? window.renderSurveyContainerSubtabsHtml("stakeout") : ""}
        ${typeof window.renderSurveyToolExplanationBannerHtml === "function" ? window.renderSurveyToolExplanationBannerHtml(
          "RTK 工地放樣點導出",
          "RTK Construction Stakeout Export",
          "於 3D 模型拾取自訂放樣點或生成規則基礎網格，嚴格依 TWD97 (E, N, Z) 順序匯出 CSV、Leica/Trimble TXT、3D DXF 及 A4 現場簽核表。",
          "Pick custom stakeout points on the 3D surface or generate a regular foundation grid. Exports strictly in TWD97 (Easting, Northing, Elevation) order to CSV, Leica/Trimble TXT, 3D DXF, and printable A4 field sheets."
        ) : ""}
        <!-- Compact Header & Mandatory E, N, Z Coordinate Pill -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:12px;font-weight:700;color:var(--ui-text-primary);">
            ${QA_SVGS.STAKEOUT} ${t("RTK 工地放樣導出", "RTK Stakeout Export")}
          </span>
          <span class="gcp-crs-pill" style="color:#059669;border-color:rgba(16,185,129,0.4);">
            PtID, E, N, Z, Code
          </span>
        </div>

        <!-- Mode Selector & Parameters -->
        <div class="gs-qa-card">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:6px;">
            <label class="gs-qa-mode-pill ${curMode === "custom" ? "active" : ""}">
              <input type="radio" name="stkSourceMode" value="custom" ${curMode === "custom" ? "checked" : ""} style="display:none;" />
              <span>${t("自選點位", "Custom Points")}</span>
            </label>
            <label class="gs-qa-mode-pill ${curMode === "grid" ? "active" : ""}">
              <input type="radio" name="stkSourceMode" value="grid" ${curMode === "grid" ? "checked" : ""} style="display:none;" />
              <span>${t("基礎網格", "Grid Array")}</span>
            </label>
          </div>

          <!-- Custom Point Code & Design Z Offset -->
          <div id="stkCustomParamsRow" style="display:${curMode === "custom" ? "grid" : "none"};grid-template-columns:1fr 1fr;gap:6px;">
            <div>
              <label style="font-size:10px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("放樣代碼 (Code)", "Point Code")}
              </label>
              <select id="stkPointCode" class="gs-select" style="width:100%;height:26px;font-size:11px;">
                <option value="DESIGN_PT">${t("DESIGN_PT (設計點)", "DESIGN_PT (Design)")}</option>
                <option value="COL_AXIS">${t("COL_AXIS (柱心軸線)", "COL_AXIS (Column)")}</option>
                <option value="EXCAV_TOE">${t("EXCAV_TOE (開挖坡腳)", "EXCAV_TOE (Toe)")}</option>
                <option value="CURB_LINE">${t("CURB_LINE (緣石線)", "CURB_LINE (Curb)")}</option>
                <option value="DRAIN_INV">${t("DRAIN_INV (溝底高程)", "DRAIN_INV (Invert)")}</option>
              </select>
            </div>
            <div>
              <label style="font-size:10px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">
                ${t("高程偏移 ΔZ (m)", "Design Z Offset (m)")}
              </label>
              <input type="number" id="stkDesignZOffset" class="gs-input" value="0.00" step="0.05" style="width:100%;height:26px;font-size:11px;" />
            </div>
          </div>

          <!-- Grid Array Parameters -->
          <div id="stkGridParamsRow" style="display:${curMode === "grid" ? "grid" : "none"};grid-template-columns:repeat(4, 1fr);gap:4px;">
            <div>
              <label style="font-size:9.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">ΔE (m)</label>
              <input type="number" id="stkGridSpacingE" class="gs-input" value="10" min="1" max="100" step="1" style="width:100%;height:25px;font-size:10.5px;" />
            </div>
            <div>
              <label style="font-size:9.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">ΔN (m)</label>
              <input type="number" id="stkGridSpacingN" class="gs-input" value="10" min="1" max="100" step="1" style="width:100%;height:25px;font-size:10.5px;" />
            </div>
            <div>
              <label style="font-size:9.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">${t("東向數", "Cols E")}</label>
              <input type="number" id="stkGridCountE" class="gs-input" value="4" min="2" max="12" step="1" style="width:100%;height:25px;font-size:10.5px;" />
            </div>
            <div>
              <label style="font-size:9.5px;color:var(--ui-text-muted);display:block;margin-bottom:2px;">${t("北向數", "Rows N")}</label>
              <input type="number" id="stkGridCountN" class="gs-input" value="4" min="2" max="12" step="1" style="width:100%;height:25px;font-size:10.5px;" />
            </div>
          </div>
        </div>

        <!-- Action Button Toolbar -->
        <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:4px;margin-top:4px;">
          <button type="button" class="btn-xs primary" id="btnGenStakeout" title="${t("生成放樣點位", "Generate Stakeout Points")}">
            ${QA_SVGS.STAKEOUT} ${t("放樣", "Stake")}
          </button>
          <button type="button" class="btn-xs ${QA_STATE.isPickingStakeoutPoint ? "primary" : ""}" id="btnPickStakeoutPt" title="${t("在 3D 視圖中點擊拾取放樣點", "Click on 3D surface to add stakeout point")}">
            ${QA_SVGS.PICK} ${t("加點", "Pick")}
          </button>
          <button type="button" class="btn-xs" id="btnClearStakeoutPts" title="${t("清除自選點並重設", "Reset custom stakeout points")}">
            ${QA_SVGS.RESET} ${t("重設", "Reset")}
          </button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:4px;margin-top:4px;">
          <button type="button" class="btn-xs" id="btnExportStakeoutCsv" title="${t("導出標準 CSV (嚴格 E N Z 順序)", "Export CSV (E, N, Z)")}">
            ${QA_SVGS.CSV} CSV
          </button>
          <button type="button" class="btn-xs" id="btnExportStakeoutTxt" title="${t("導出 Leica/Trimble TXT", "Export Leica/Trimble TXT")}">
            ${QA_SVGS.PIPE} TXT
          </button>
          <button type="button" class="btn-xs" id="btnExportStakeoutDxf" title="${t("導出 3D AutoCAD DXF R12", "Export 3D AutoCAD DXF")}">
            ${QA_SVGS.DXF} DXF
          </button>
          <button type="button" class="btn-xs" id="btnPrintStakeoutSheet" title="${t("列印 A4 現場放樣檢核記錄表", "Print A4 Field Stakeout Sheet")}">
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
    if (typeof window.bindSurveyContainerSubtabs === "function") {
      window.bindSurveyContainerSubtabs("stakeout");
    }
    bindRtkStakeoutEvents(scanId);
    runGenerateStakeout(scanId, { focusCamera: false });
  }

  function bindRtkStakeoutEvents(scanId) {
    document.querySelectorAll('input[name="stkSourceMode"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        const mode = e.target.value;
        QA_STATE.stakeoutSourceMode = mode;
        document.querySelectorAll("#rtkStakeoutContainer .gs-qa-mode-pill").forEach((p) => p.classList.remove("active"));
        e.target.closest(".gs-qa-mode-pill")?.classList.add("active");
        const customRow = document.getElementById("stkCustomParamsRow");
        const gridRow = document.getElementById("stkGridParamsRow");
        if (customRow) customRow.style.display = mode === "custom" ? "grid" : "none";
        if (gridRow) gridRow.style.display = mode === "grid" ? "grid" : "none";
        if (mode === "grid") {
          QA_STATE.isPickingStakeoutPoint = false;
          document.getElementById("btnPickStakeoutPt")?.classList.remove("primary");
        }
        runGenerateStakeout(scanId, { focusCamera: false });
      });
    });

    ["stkGridSpacingE", "stkGridSpacingN", "stkGridCountE", "stkGridCountN"].forEach((id) => {
      document.getElementById(id)?.addEventListener("change", () => {
        runGenerateStakeout(scanId, { focusCamera: false });
      });
    });

    document.getElementById("btnGenStakeout")?.addEventListener("click", () => {
      runGenerateStakeout(scanId, { focusCamera: true });
    });

    document.getElementById("btnPickStakeoutPt")?.addEventListener("click", () => {
      const customRadio = document.querySelector('input[name="stkSourceMode"][value="custom"]');
      if (customRadio && !customRadio.checked) {
        customRadio.checked = true;
        customRadio.dispatchEvent(new Event("change"));
      }
      QA_STATE.isPickingStakeoutPoint = !QA_STATE.isPickingStakeoutPoint;
      document.getElementById("btnPickStakeoutPt")?.classList.toggle("primary", QA_STATE.isPickingStakeoutPoint);
      if (typeof showToast === "function") {
        showToast(
          QA_STATE.isPickingStakeoutPoint
            ? t("3D 拾取模式已開啟 — 請在 3D 模型表面點擊新增放樣點", "3D pick active — click on the 3D surface to add stakeout points")
            : t("已結束 3D 放樣點拾取模式", "Exited 3D stakeout point pick mode")
        );
      }
    });

    document.getElementById("btnClearStakeoutPts")?.addEventListener("click", () => {
      QA_STATE.stakeoutPoints = [];
      QA_STATE.isPickingStakeoutPoint = false;
      document.getElementById("btnPickStakeoutPt")?.classList.remove("primary");
      runGenerateStakeout(scanId, { focusCamera: false });
      if (typeof showToast === "function") {
        showToast(t("已重設放樣點位列表", "Stakeout point list reset"));
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

    document.getElementById("btnExportStakeoutDxf")?.addEventListener("click", () => {
      if (!QA_STATE.stakeoutLastResult) return;
      downloadBlob(
        QA_STATE.stakeoutLastResult.dxf_export || "",
        `stakeout_3D_${QA_STATE.stakeoutLastResult.scan_id || "site"}.dxf`,
        "application/dxf;charset=utf-8;"
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

  async function runGenerateStakeout(scanId, opts = {}) {
    const srcMode = document.querySelector('input[name="stkSourceMode"]:checked')?.value || QA_STATE.stakeoutSourceMode || "custom";
    QA_STATE.stakeoutSourceMode = srcMode;
    const spacingE = Math.max(1, safeFloat(document.getElementById("stkGridSpacingE")?.value, 10));
    const spacingN = Math.max(1, safeFloat(document.getElementById("stkGridSpacingN")?.value, 10));
    const countE = Math.max(2, Math.min(15, Math.round(safeFloat(document.getElementById("stkGridCountE")?.value, 4))));
    const countN = Math.max(2, Math.min(15, Math.round(safeFloat(document.getElementById("stkGridCountN")?.value, 4))));

    let gridOriginE = null;
    let gridOriginN = null;
    if (typeof window.localToTwd97 === "function") {
      const centerTwd = window.localToTwd97({ x: 0, y: 0, z: 0 });
      if (centerTwd && Number.isFinite(centerTwd.e) && Number.isFinite(centerTwd.n)) {
        gridOriginE = Number((centerTwd.e - ((countE - 1) * spacingE) * 0.5).toFixed(3));
        gridOriginN = Number((centerTwd.n - ((countN - 1) * spacingN) * 0.5).toFixed(3));
      }
    }

    const payload = {
      scan_id: scanId || (window.STATE && window.STATE.activeScanId) || "",
      source_mode: srcMode,
      points: srcMode === "custom" && QA_STATE.stakeoutPoints.length > 0 ? QA_STATE.stakeoutPoints : null,
      grid_origin_e: gridOriginE,
      grid_origin_n: gridOriginN,
      grid_spacing_e: spacingE,
      grid_spacing_n: spacingN,
      grid_count_e: countE,
      grid_count_n: countN,
    };

    try {
      const res = typeof apiPost === "function" ? await apiPost("/api/survey/stakeout-export", payload) : null;
      if (!res || res.status !== "ok") return;
      QA_STATE.stakeoutLastResult = res;
      // Render 3D first so mesh surface draping updates point elevations if needed
      renderStakeout3DOverlay(res, opts);
      renderStakeoutPointsTable(res);
    } catch (err) {
      console.error("[RTKStakeout] Error:", err);
    }
  }

  function renderStakeoutPointsTable(res) {
    const card = document.getElementById("stakeoutPointsCard");
    if (!card) return;

    const pts = res.points || [];
    const isCustom = QA_STATE.stakeoutSourceMode !== "grid" && QA_STATE.stakeoutPoints.length > 0;
    let rows = "";
    pts.forEach((p, idx) => {
      rows += `
        <tr class="stk-point-row" data-stk-idx="${idx}" style="cursor:pointer;" title="${t("點擊聚焦至 3D 放樣點", "Click to focus 3D camera on stakeout point")}">
          <td style="font-weight:700;color:#fbbf24;">${p.ptid}</td>
          <td style="font-family:monospace;text-align:right;">${Number(p.easting).toFixed(3)}</td>
          <td style="font-family:monospace;text-align:right;">${Number(p.northing).toFixed(3)}</td>
          <td style="font-family:monospace;text-align:right;font-weight:700;color:#38bdf8;">${Number(p.elevation).toFixed(3)}</td>
          <td>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
              <span>${p.code}</span>
              ${isCustom ? `<button type="button" class="btn-del-stk-pt" data-del-stk-idx="${idx}" style="border:none;background:rgba(239,68,68,0.18);color:#f87171;border-radius:4px;padding:0 5px;font-size:10px;cursor:pointer;" title="${t("刪除此點", "Delete point")}">x</button>` : ""}
            </div>
          </td>
        </tr>
      `;
    });

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--ui-text-secondary);margin-bottom:4px;">
        <span>${t(`共 ${pts.length} 個放樣點 (點擊列可聚焦 3D 位置)`, `${pts.length} stakeout points (click row to focus in 3D)`)}</span>
        <span style="color:#fbbf24;font-weight:600;">${QA_STATE.stakeoutSourceMode === "grid" ? t("規則基礎網格", "Grid Array") : QA_STATE.stakeoutPoints.length > 0 ? t("自訂拾取點", "Custom Picked") : t("預設示範點", "Default Sample")}</span>
      </div>
      <div style="max-height:210px;overflow-y:auto;border:1px solid var(--ui-border);border-radius:6px;">
        <table class="gs-qa-table" style="width:100%;font-size:10px;">
          <thead>
            <tr>
              <th>${t("點號 PtID", "PtID")}</th>
              <th style="text-align:right;">${t("東距 E (m)", "Easting (m)")}</th>
              <th style="text-align:right;">${t("北距 N (m)", "Northing (m)")}</th>
              <th style="text-align:right;">${t("高程 Z (m)", "Elev (m)")}</th>
              <th>${t("代碼 Code", "Code")}</th>
            </tr>
          </thead>
          <tbody id="stakeoutPtsBody">
            ${rows}
          </tbody>
        </table>
      </div>
    `;

    card.querySelectorAll(".stk-point-row").forEach((trEl) => {
      trEl.addEventListener("click", (ev) => {
        if (ev.target && ev.target.closest(".btn-del-stk-pt")) return;
        const idx = parseInt(trEl.getAttribute("data-stk-idx") || "-1", 10);
        const pt = pts[idx];
        if (!pt) return;
        const localVec =
          pt._localVec ||
          (typeof window.surveyTwd97ToLocalVec3 === "function"
            ? window.surveyTwd97ToLocalVec3(pt.easting, pt.northing, pt.elevation, false, [pt.local_x, pt.local_y, pt.local_z])
            : null);
        if (localVec && typeof window.focusStudioCameraOnLocalPoint === "function") {
          window.focusStudioCameraOnLocalPoint(localVec, 16);
        }
      });
    });

    card.querySelectorAll(".btn-del-stk-pt").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const idx = parseInt(btn.getAttribute("data-del-stk-idx") || "-1", 10);
        if (idx >= 0 && idx < QA_STATE.stakeoutPoints.length) {
          QA_STATE.stakeoutPoints.splice(idx, 1);
          QA_STATE.stakeoutPoints.forEach((item, i) => {
            item.ptid = `STK-${String(i + 1).padStart(3, "0")}`;
          });
          const scanId = (window.STATE && window.STATE.activeScanId) || "";
          runGenerateStakeout(scanId, { focusCamera: false });
        }
      });
    });
  }

  function renderStakeout3DOverlay(res, opts = {}) {
    if (!window.studioThree || !window.studioThree.scene || !window.THREE) return;
    clearStakeoutVisuals3D();
    stakeout3DGroup = new window.THREE.Group();
    stakeout3DGroup.name = "GS_Stakeout_Overlay";

    const pts = (res && res.points) || [];
    const THREE = window.THREE;

    const minPt = new THREE.Vector3(Infinity, Infinity, Infinity);
    const maxPt = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    const ringGeo = new THREE.RingGeometry(0.32, 0.62, 24);
    ringGeo.rotateX(-Math.PI / 2);

    pts.forEach((p, idx) => {
      const e = p.e !== undefined ? p.e : p.easting;
      const n = p.n !== undefined ? p.n : p.northing;
      const h = p.h !== undefined ? p.h : p.elevation;
      const explicitLocal =
        Number.isFinite(Number(p.local_x)) && Number.isFinite(Number(p.local_y)) && Number.isFinite(Number(p.local_z))
          ? [Number(p.local_x), Number(p.local_y), Number(p.local_z)]
          : null;

      const posVec =
        typeof window.surveyTwd97ToLocalVec3 === "function"
          ? window.surveyTwd97ToLocalVec3(e, n, h, !p._exactPicked, explicitLocal)
          : new THREE.Vector3(0, 0, 0);

      p._localVec = posVec;
      p.local_x = Number(posVec.x.toFixed(3));
      p.local_y = Number(posVec.y.toFixed(3));
      p.local_z = Number(posVec.z.toFixed(3));
      if (posVec.hitMesh && !p._exactPicked && Number.isFinite(posVec.surfaceH)) {
        p.elevation = Number(posVec.surfaceH.toFixed(3));
      }

      const colHex = p._exactPicked ? 0x10b981 : 0xf59e0b;

      // 1. Zoom-invariant 3D Survey Pin
      if (typeof window.add3DPinMarker === "function") {
        window.add3DPinMarker(posVec, colHex, stakeout3DGroup);
      }

      // 2. High-visibility ground target ring
      const ringMat = new THREE.MeshBasicMaterial({
        color: colHex,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
      });
      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.position.set(posVec.x, posVec.y + 0.04, posVec.z);
      ringMesh.renderOrder = 997;
      stakeout3DGroup.add(ringMesh);

      // 3. Vertical survey range pole
      const dropGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(posVec.x, posVec.y, posVec.z),
        new THREE.Vector3(posVec.x, posVec.y + 1.6, posVec.z),
      ]);
      const dropMat = new THREE.LineBasicMaterial({ color: colHex, depthTest: false });
      const dropLine = new THREE.Line(dropGeo, dropMat);
      dropLine.renderOrder = 997;
      stakeout3DGroup.add(dropLine);

      // 4. Floating 2D Label Badge
      if (typeof window.add2DBadge === "function") {
        const badgePos = new THREE.Vector3(posVec.x, posVec.y + 1.65, posVec.z);
        const labelHtml = `<span style="color:${p._exactPicked ? "#34d399" : "#fbbf24"};font-weight:700;">${p.ptid}</span> <span style="opacity:0.9;">Z:${Number(p.elevation).toFixed(2)}m</span>`;
        window.add2DBadge(badgePos, labelHtml, "badge-stakeout-pt", {
          isSurveyToolBadge: true,
          surveyTool: "stakeout",
          priority: 95 - idx,
        });
      }

      minPt.x = Math.min(minPt.x, posVec.x);
      minPt.y = Math.min(minPt.y, posVec.y);
      minPt.z = Math.min(minPt.z, posVec.z);
      maxPt.x = Math.max(maxPt.x, posVec.x);
      maxPt.y = Math.max(maxPt.y, posVec.y);
      maxPt.z = Math.max(maxPt.z, posVec.z);
    });

    if (window.studioThree.overlayGroup) {
      window.studioThree.overlayGroup.add(stakeout3DGroup);
    } else {
      window.studioThree.scene.add(stakeout3DGroup);
    }

    if (opts.focusCamera && pts.length > 0 && window.studioThree.camera && window.studioThree.controls) {
      const center = new THREE.Vector3().addVectors(minPt, maxPt).multiplyScalar(0.5);
      const span = Math.max(maxPt.x - minPt.x, maxPt.z - minPt.z, 14);
      window.studioThree.controls.target.copy(center);
      window.studioThree.camera.position.set(center.x + span * 0.65, center.y + span * 0.55, center.z + span * 0.65);
      window.studioThree.controls.update();
    }

    if (typeof window.updateZoomInvariantElements === "function") {
      window.updateZoomInvariantElements();
    }
    if (typeof window.update2DBadgePositions === "function") {
      window.update2DBadgePositions();
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
  window.ensureMaxQualityTilesForFlatnessBoxAsync = ensureMaxQualityTilesForFlatnessBoxAsync;
  window.exportFlatnessReportWithScreenshots = exportFlatnessReportWithScreenshots;
  window.selectFlatnessObject = selectFlatnessObject;
  window.deleteFlatnessObject = deleteFlatnessObject;
  window.toggleFlatnessObjectVisibility = toggleFlatnessObjectVisibility;
  window.startNewFlatnessObjectDraft = startNewFlatnessObjectDraft;
  window.getFlatnessObjectsForActiveScan = getFlatnessObjectsForActiveScan;
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
        startNewFlatnessObjectDraft(false);
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
      const customRadio = document.querySelector('input[name="stkSourceMode"][value="custom"]');
      if (customRadio && !customRadio.checked) {
        customRadio.checked = true;
        QA_STATE.stakeoutSourceMode = "custom";
        document.querySelectorAll("#rtkStakeoutContainer .gs-qa-mode-pill").forEach((p) => p.classList.remove("active"));
        customRadio.closest(".gs-qa-mode-pill")?.classList.add("active");
        const customRow = document.getElementById("stkCustomParamsRow");
        const gridRow = document.getElementById("stkGridParamsRow");
        if (customRow) customRow.style.display = "grid";
        if (gridRow) gridRow.style.display = "none";
      }
      const codeVal = document.getElementById("stkPointCode")?.value || "DESIGN_PT";
      const zOffset = safeFloat(document.getElementById("stkDesignZOffset")?.value, 0.0);
      const idx = QA_STATE.stakeoutPoints.length + 1;
      const ptid = `STK-${String(idx).padStart(3, "0")}`;
      const elev = Number((twd.h + zOffset).toFixed(3));
      QA_STATE.stakeoutPoints.push({
        ptid,
        easting: Number(twd.e.toFixed(3)),
        northing: Number(twd.n.toFixed(3)),
        elevation: elev,
        code: codeVal,
        local_x: pt && Number.isFinite(pt.x) ? Number(pt.x.toFixed(3)) : undefined,
        local_y: pt && Number.isFinite(pt.y) ? Number((pt.y + zOffset).toFixed(3)) : undefined,
        local_z: pt && Number.isFinite(pt.z) ? Number(pt.z.toFixed(3)) : undefined,
        _exactPicked: true,
      });
      if (typeof showToast === "function") {
        showToast(
          t(
            `已新增放樣點 ${ptid} (E:${twd.e.toFixed(2)}, N:${twd.n.toFixed(2)}, Z:${elev.toFixed(2)}m)`,
            `Added ${ptid} (E:${twd.e.toFixed(2)}, N:${twd.n.toFixed(2)}, Z:${elev.toFixed(2)}m)`
          )
        );
      }
      runGenerateStakeout(scanId, { focusCamera: false });
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
