/**
 * GatheringScans Frontend Module 03 — 3D Scan Studio Core, CRS Math, First-Person Engine & Live Measurements/Laser
 */
"use strict";

  // ============================================================================
  // 2. 3D SCAN STUDIO (Three.js + 3D Tileset + TWD97/TWVD2001 + Civil Tools)
  // ============================================================================
  let studioThree = null;

  let _defaultBaseElevTex = null;
  function getDefaultBaseElevTex() {
    if (!_defaultBaseElevTex && window.THREE) {
      const data = new Uint8Array([128, 0, 0, 0]);
      _defaultBaseElevTex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      _defaultBaseElevTex.needsUpdate = true;
    }
    return _defaultBaseElevTex;
  }

  // Apply Scan Brightness (0.1x – 4.0x) and optional Z / Delta-Z Elevation Heatmap to any Three.js material
  function applyBrightnessToMaterial(mat, brightness) {
    if (!mat) return;
    const b = Math.max(0.1, Math.min(4.0, Number(brightness) || 1.0));
    if (!mat.userData) mat.userData = {};
    if (mat.side !== THREE.DoubleSide) {
      mat.side = THREE.DoubleSide;
      mat.needsUpdate = true;
    }
    if (typeof mat.metalness === "number" && mat.metalness > 0) {
      mat.metalness = 0.0;
      mat.roughness = 1.0;
      mat.needsUpdate = true;
    }
    mat.userData._lastBrightness = b;
    if (mat.map && mat.color) {
      mat.color.setRGB(1, 1, 1);
      const isMobOrIOS =
        (typeof isIOSOrIPadDevice === "function" && isIOSOrIPadDevice()) ||
        (typeof isMobileOrTabletDevice === "function" && isMobileOrTabletDevice());
      if (isMobOrIOS) {
        if (mat.map.anisotropy !== 1 || mat.map.generateMipmaps !== false) {
          mat.map.anisotropy = 1;
          mat.map.generateMipmaps = false;
          mat.map.minFilter = THREE.LinearFilter;
          mat.map.needsUpdate = true;
        }
      } else {
        const maxAniso = Math.min(16, studioThree?.renderer?.capabilities?.getMaxAnisotropy?.() || 16);
        if (!mat.map.anisotropy || mat.map.anisotropy < maxAniso) {
          mat.map.anisotropy = maxAniso;
          mat.map.needsUpdate = true;
        }
      }
    }
    if (mat.color && !mat.userData._origColor) {
      mat.userData._origColor = mat.color.clone();
    }
    if (mat.color && mat.userData._origColor) {
      mat.color.copy(mat.userData._origColor);
    }

    const heatmapFlag = mat.userData._elevationHeatmapActive
      ? mat.userData._deltaZMode
        ? 2.0
        : 1.0
      : 0.0;
    const elevMin = Number.isFinite(mat.userData._elevMin) ? mat.userData._elevMin : -14.0;
    const elevMax = Number.isFinite(mat.userData._elevMax) ? mat.userData._elevMax : 24.0;
    const baseTex = mat.userData._baseElevTex || getDefaultBaseElevTex();
    const baseBounds = mat.userData._baseBounds || new THREE.Vector4(-80, -80, 80, 80);
    const baseYRange = mat.userData._baseYRange || new THREE.Vector2(-20, 30);
    const baseMeanY = Number.isFinite(mat.userData._baseMeanY) ? mat.userData._baseMeanY : 0.0;
    const baseGridN = Number.isFinite(mat.userData._baseGridN) ? mat.userData._baseGridN : 96.0;

    if (!mat.userData.PassUniforms) {
      mat.userData.PassUniforms = {
        uBrightness: { value: b },
        uElevationHeatmap: { value: heatmapFlag },
        uElevMin: { value: elevMin },
        uElevMax: { value: elevMax },
        uBaseElevMap: { value: baseTex },
        uBaseBounds: { value: baseBounds },
        uBaseYRange: { value: baseYRange },
        uBaseMeanY: { value: baseMeanY },
        uBaseGridN: { value: baseGridN },
      };
    } else {
      if (mat.userData.PassUniforms.uBrightness) mat.userData.PassUniforms.uBrightness.value = b;
      if (mat.userData.PassUniforms.uElevationHeatmap) mat.userData.PassUniforms.uElevationHeatmap.value = heatmapFlag;
      if (mat.userData.PassUniforms.uElevMin) mat.userData.PassUniforms.uElevMin.value = elevMin;
      if (mat.userData.PassUniforms.uElevMax) mat.userData.PassUniforms.uElevMax.value = elevMax;
      if (mat.userData.PassUniforms.uBaseElevMap) mat.userData.PassUniforms.uBaseElevMap.value = baseTex;
      if (mat.userData.PassUniforms.uBaseBounds) mat.userData.PassUniforms.uBaseBounds.value = baseBounds;
      if (mat.userData.PassUniforms.uBaseYRange) mat.userData.PassUniforms.uBaseYRange.value = baseYRange;
      if (mat.userData.PassUniforms.uBaseMeanY) mat.userData.PassUniforms.uBaseMeanY.value = baseMeanY;
      if (mat.userData.PassUniforms.uBaseGridN) mat.userData.PassUniforms.uBaseGridN.value = baseGridN;
    }

    if (!mat.userData._hasBrightnessShader) {
      mat.userData._hasBrightnessShader = true;
      mat.customProgramCacheKey = function () {
        return `GS_ScanShader_v6_${mat.type || "Standard"}_${mat.map ? "1" : "0"}_${mat.vertexColors ? "1" : "0"}`;
      };
      const prevOnBeforeCompile = mat.onBeforeCompile;
      mat.onBeforeCompile = function (shader, renderer) {
        if (typeof prevOnBeforeCompile === "function") {
          prevOnBeforeCompile.call(this, shader, renderer);
        }
        shader.uniforms.uBrightness = mat.userData.PassUniforms.uBrightness;
        shader.uniforms.uElevationHeatmap = mat.userData.PassUniforms.uElevationHeatmap;
        shader.uniforms.uElevMin = mat.userData.PassUniforms.uElevMin;
        shader.uniforms.uElevMax = mat.userData.PassUniforms.uElevMax;
        shader.uniforms.uBaseElevMap = mat.userData.PassUniforms.uBaseElevMap;
        shader.uniforms.uBaseBounds = mat.userData.PassUniforms.uBaseBounds;
        shader.uniforms.uBaseYRange = mat.userData.PassUniforms.uBaseYRange;
        shader.uniforms.uBaseMeanY = mat.userData.PassUniforms.uBaseMeanY;
        shader.uniforms.uBaseGridN = mat.userData.PassUniforms.uBaseGridN;

        shader.vertexShader = shader.vertexShader.replace(
          "#include <common>",
          `#include <common>
           varying vec3 vGsWorldPos;`
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <project_vertex>",
          `#include <project_vertex>
           vec4 gsWorldPos4 = modelMatrix * vec4(transformed, 1.0);
           vGsWorldPos = gsWorldPos4.xyz;`
        );

        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          `#include <common>
           uniform float uBrightness;
           uniform float uElevationHeatmap;
           uniform float uElevMin;
           uniform float uElevMax;
           uniform sampler2D uBaseElevMap;
           uniform vec4 uBaseBounds;
           uniform vec2 uBaseYRange;
           uniform float uBaseMeanY;
           uniform float uBaseGridN;
           varying vec3 vGsWorldPos;
           vec3 gcScanPhotoColor = vec3(0.0);
           bool gcHasPhotoColor = false;
           float gsSampleBaseElevCell(vec2 ij) {
             float gMax = max(1.0, uBaseGridN - 1.0);
             vec2 uv = (clamp(ij, vec2(0.0), vec2(gMax)) + 0.5) / max(2.0, uBaseGridN);
             vec4 s = texture2D(uBaseElevMap, uv);
             if (s.a < 0.5) return uBaseMeanY;
             float n = clamp((s.r * 256.0 + s.g) / 257.0, 0.0, 1.0);
             return mix(uBaseYRange.x, uBaseYRange.y, n);
           }
           vec3 gsElevationRamp(float t) {
             vec3 c0 = vec3(0.14, 0.38, 0.92); // Deep Blue (Cut / Low Z)
             vec3 c1 = vec3(0.02, 0.71, 0.83); // Cyan
             vec3 c2 = vec3(0.06, 0.73, 0.51); // Emerald Green (0.0m / Mid Z)
             vec3 c3 = vec3(0.96, 0.62, 0.04); // Amber
             vec3 c4 = vec3(0.94, 0.27, 0.27); // Red (Fill / High Z)
             if (t < 0.25) return mix(c0, c1, t * 4.0);
             if (t < 0.50) return mix(c1, c2, (t - 0.25) * 4.0);
             if (t < 0.75) return mix(c2, c3, (t - 0.50) * 4.0);
             return mix(c3, c4, (t - 0.75) * 4.0);
           }`
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
           vec3 litPhoto = (uBrightness > 1.0)
             ? (basePhoto * uBrightness) / (1.0 + max(vec3(0.0), basePhoto * (uBrightness - 1.0)) * 0.35)
             : (basePhoto * uBrightness);
           if (uElevationHeatmap > 1.5) {
             vec2 relUv = clamp((vGsWorldPos.xz - uBaseBounds.xy) / max(vec2(0.5), uBaseBounds.zw - uBaseBounds.xy), 0.0, 1.0);
             vec2 gCoord = relUv * max(1.0, uBaseGridN - 1.0);
             vec2 g0 = floor(gCoord);
             vec2 gf = gCoord - g0;
             float h00 = gsSampleBaseElevCell(g0);
             float h10 = gsSampleBaseElevCell(g0 + vec2(1.0, 0.0));
             float h01 = gsSampleBaseElevCell(g0 + vec2(0.0, 1.0));
             float h11 = gsSampleBaseElevCell(g0 + vec2(1.0, 1.0));
             float baseY = mix(mix(h00, h10, gf.x), mix(h01, h11, gf.x), gf.y);
             float dz = vGsWorldPos.y - baseY;
             float halfSpan = max(0.5, uElevMax);
             float elevT = clamp(0.5 + (dz / (halfSpan * 2.0)), 0.0, 1.0);
             vec3 ramp = gsElevationRamp(elevT);
             float luma = clamp(dot(litPhoto, vec3(0.299, 0.587, 0.114)), 0.22, 1.15);
             float contourBand = smoothstep(0.91, 0.99, abs(fract(dz * 1.0) * 2.0 - 1.0));
             vec3 heatRgb = mix(ramp * (0.52 + 0.56 * luma), litPhoto, 0.18);
             gl_FragColor.rgb = mix(heatRgb, heatRgb * 1.25, contourBand * 0.32);
           } else if (uElevationHeatmap > 0.5) {
             float elevT = clamp((vGsWorldPos.y - uElevMin) / max(0.5, uElevMax - uElevMin), 0.0, 1.0);
             vec3 ramp = gsElevationRamp(elevT);
             float luma = clamp(dot(litPhoto, vec3(0.299, 0.587, 0.114)), 0.22, 1.15);
             float contourBand = smoothstep(0.91, 0.99, abs(fract(vGsWorldPos.y * 0.5) * 2.0 - 1.0));
             vec3 heatRgb = mix(ramp * (0.52 + 0.56 * luma), litPhoto, 0.20);
             gl_FragColor.rgb = mix(heatRgb, heatRgb * 1.25, contourBand * 0.32);
           } else {
             gl_FragColor.rgb = litPhoto;
           }`
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

  function installSurfaceAwareOrbitZoom(domEl, getViewerFn, opts = {}) {
    if (!domEl || domEl._surfaceZoomBound) return;
    domEl._surfaceZoomBound = true;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const collectTargetMeshes = (v) => {
      const list = [];
      const roots = [v?.modelPivot, v?.multiAlignGroup, v?.fallbackGroup, v?.left?.modelPivot, v?.right?.modelPivot];
      roots.forEach((r) => {
        if (!r || !r.visible) return;
        r.traverse((c) => {
          if (
            c.isMesh &&
            (typeof isMeshVisibleUnderRoot === "function" ? isMeshVisibleUnderRoot(c, r) : c.visible) &&
            !c.userData?.isAlignBoxHelper
          ) {
            list.push(c);
          }
        });
      });
      return list;
    };
    const syncExtraCams = (v) => {
      if (v && v.left && v.right && v.left.camera) {
        [v.right, v.third, v.fourth].forEach((s) => {
          if (s && s.camera) {
            s.camera.position.copy(v.left.camera.position);
            s.camera.quaternion.copy(v.left.camera.quaternion);
          }
        });
      }
    };

    domEl.addEventListener(
      "wheel",
      (e) => {
        const v = typeof getViewerFn === "function" ? getViewerFn() : null;
        const cam = v?.camera || v?.left?.camera;
        const ctrls = v?.controls;
        if (!cam || !ctrls || !ctrls.enabled || ctrls.enableZoom === false) return;
        if (opts.isStudio && (STATE.fpMode?.active || STATE.activeView !== "studio")) return;
        if (e.deltaY >= 0) return; // Zoom-out works normally

        const viewDir = new THREE.Vector3().subVectors(ctrls.target, cam.position);
        const curTargetDist = viewDir.length();
        if (curTargetDist > 1e-6) {
          viewDir.divideScalar(curTargetDist);
        } else {
          cam.getWorldDirection(viewDir);
        }

        const meshes = collectTargetMeshes(v);
        if (!meshes.length) return;
        ray.set(cam.position, viewDir);
        let hits = ray.intersectObjects(meshes, false);
        let surfDist = hits.length ? hits[0].distance : null;

        if (!Number.isFinite(surfDist)) {
          const rect = domEl.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            if (Number.isFinite(ndc.x) && Math.abs(ndc.x) <= 1.05 && Math.abs(ndc.y) <= 1.05) {
              ray.setFromCamera(ndc, cam);
              const cursorHits = ray.intersectObjects(meshes, false);
              if (cursorHits.length) {
                const proj = new THREE.Vector3().subVectors(cursorHits[0].point, cam.position).dot(viewDir);
                if (proj > 0.1) surfDist = proj;
              }
            }
          }
        }
        if (!Number.isFinite(surfDist)) {
          // Off-mesh fallback: intersect camera view ray with scan ground plane so high mid-air targets never stall
          const groundY = Number.isFinite(v?.grid?.position?.y) ? v.grid.position.y : -7.0;
          if (viewDir.y < -0.04 && cam.position.y > groundY + 0.2) {
            const tGround = (groundY - cam.position.y) / viewDir.y;
            if (tGround > 0.1 && tGround < 400) {
              surfDist = tGround;
            }
          }
        }
        if (!Number.isFinite(surfDist)) return;

        // Prevent subsurface punch-through when already within 18 cm of the surface (zero rotation!)
        if (surfDist <= 0.18) {
          e.stopImmediatePropagation();
          e.preventDefault();
          return;
        }

        // Move camera and target strictly along the existing look axis `viewDir` so the camera NEVER rotates when zooming!
        const savedQuat = cam.quaternion.clone();
        const stepAdvance = Math.min(surfDist - 0.15, Math.max(0.18, surfDist * 0.085));
        if (stepAdvance > 0) {
          cam.position.addScaledVector(viewDir, stepAdvance);
        }
        const remDist = Math.max(0.14, surfDist - Math.max(0, stepAdvance));
        ctrls.target.copy(cam.position).addScaledVector(viewDir, Math.max(0.12, remDist * 0.88));
        cam.quaternion.copy(savedQuat);
        syncExtraCams(v);
      },
      { passive: false, capture: true }
    );
  }
  window.installSurfaceAwareOrbitZoom = installSurfaceAwareOrbitZoom;

  function initStudio3D() {
    if (studioThree) return studioThree;
    const container = document.getElementById("studioCanvasContainer");
    if (!container) return null;

    const isDark = STATE.resolvedTheme === "dark";
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(isDark ? 0x0b0f19 : 0xe2e8f0);

    const camera = new THREE.PerspectiveCamera(
      50,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.03,
      10000
    );
    camera.position.set(45, 38, 55);

    const isIOS = typeof isIOSOrIPadDevice === "function" && isIOSOrIPadDevice();
    const renderer = new THREE.WebGLRenderer({
      antialias: !isIOS,
      powerPreference: isIOS ? "default" : "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isIOS ? 1.5 : 2));
    renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.localClippingEnabled = true;
    container.appendChild(renderer.domElement);

    renderer.domElement.addEventListener(
      "webglcontextlost",
      (ev) => {
        ev.preventDefault();
        if (studioThree) {
          studioThree._contextLost = true;
          studioThree._forceLowMemStream = true;
          renderer.setPixelRatio(1);
        }
      },
      false
    );
    renderer.domElement.addEventListener(
      "webglcontextrestored",
      () => {
        if (studioThree) {
          studioThree._contextLost = false;
          if (STATE.activeView === "studio" && STATE.activeScanId) {
            loadScanIntoStudio(STATE.activeScanId, { preserveCamera: true, preserveTools: true });
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
    installSurfaceAwareOrbitZoom(renderer.domElement, () => studioThree, { isStudio: true });
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
      SHARE_TELEMETRY.recordCameraInteraction("studio");
    });
    renderer.domElement.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    renderer.domElement.addEventListener("auxclick", (e) => {
      if (e.button === 1) e.preventDefault();
    });

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const hemi = new THREE.HemisphereLight(0xffffff, 0x475569, 0.45);
    scene.add(hemi);
    const dir1 = new THREE.DirectionalLight(0xffffff, 0.6);
    dir1.position.set(120, 220, 120);
    scene.add(dir1);

    const grid = new THREE.GridHelper(240, 24, isDark ? 0x334155 : 0x94a3b8, isDark ? 0x1e293b : 0xcbd5e1);
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

    const categoryGroup = new THREE.Group();
    scene.add(categoryGroup);

    const commentPinsGroup = new THREE.Group();
    scene.add(commentPinsGroup);

    const multiAlignGroup = new THREE.Group();
    multiAlignGroup.visible = false;
    scene.add(multiAlignGroup);

    const gizmoGroup = new THREE.Group();
    gizmoGroup.visible = false;
    scene.add(gizmoGroup);

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    studioThree = {
      container,
      scene,
      camera,
      renderer,
      controls,
      grid,
      modelPivot,
      fallbackGroup,
      overlayGroup,
      volumeGroup,
      polyPreviewGroup,
      contourGroup,
      categoryGroup,
      commentPinsGroup,
      multiAlignGroup,
      gizmoGroup,
      raycaster,
      mouse,
      tilesRenderer: null,
      loadedMesh: null,
      boundingSphere: null,
      tilesCenter: [0, 0, 0],
      tileUpMatrix: new THREE.Matrix4(),
      _cancelLassoDrag: null,
      _lassoHighlightTimer: null,
    };

    buildReferenceTerrainMesh(studioThree);
    buildStudioTransformGizmo(studioThree);

    // Freehand 2D/3D Camera-Frustum Lasso Drag State (Default: Mark for Deletion, Middle-Wheel = Rotate, Esc = Cancel)
    const _lassoState = {
      dragging: false,
      pointerId: null,
      op: "add",
      totalArcLen: 0,
      screenPts: [],
      downClient: { x: 0, y: 0 },
      chordOrbitActive: false,
      chordLastX: 0,
      chordLastY: 0,
    };

    const updateLassoSvgVisual = () => {
      const svg = document.getElementById("studioLassoSvg");
      const poly = document.getElementById("studioLassoPoly") || document.getElementById("studioLassoPolygon");
      const line = document.getElementById("studioLassoLine") || document.getElementById("studioLassoPolyline");
      if (!svg || !poly || !line) return;
      if (!_lassoState.dragging || _lassoState.screenPts.length < 2) {
        svg.classList.remove("active", "keep-mode", "sub-mode");
        poly.setAttribute("points", "");
        line.setAttribute("points", "");
        return;
      }
      svg.classList.add("active");
      const isSub = _lassoState.op === "sub";
      const isKeep = !isSub && STATE.cropMode === "keep_inside" && STATE.activeTool === "crop";
      svg.classList.toggle("sub-mode", isSub);
      svg.classList.toggle("keep-mode", isKeep);
      const ptsStr = _lassoState.screenPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      poly.setAttribute("points", ptsStr);
      line.setAttribute("points", ptsStr);
    };

    const cancelActiveLassoDrag = (e = null) => {
      if (!_lassoState.dragging && !_lassoState.chordOrbitActive) return;
      if (_lassoState.pointerId !== null) {
        try {
          renderer.domElement.releasePointerCapture(_lassoState.pointerId);
        } catch (_) {}
      }
      _lassoState.dragging = false;
      _lassoState.pointerId = null;
      _lassoState.screenPts = [];
      _lassoState.totalArcLen = 0;
      _lassoState.chordOrbitActive = false;
      controls.enabled = true;
      syncStudioControlsForTool();
      updateLassoSvgVisual();
    };
    studioThree._cancelLassoDrag = cancelActiveLassoDrag;
    studioThree._isLassoDragging = () => Boolean(_lassoState.dragging || _lassoState.chordOrbitActive);

    const finalizeLassoStrokePoints = (ptsCopy, arcLen, strokeOp) => {
      if (!ptsCopy || ptsCopy.length < 4 || arcLen < 18) return false;
      const isKeep = STATE.cropMode === "keep_inside" && STATE.activeTool === "crop";
      const isDelete = !isKeep;
      STATE.cropMode = isDelete ? "delete_inside" : "keep_inside";
      if (strokeOp === "sub" && (!STATE.lassoStrokes || STATE.lassoStrokes.length === 0)) {
        showToast("Mark a region with Left-Drag first, then Alt+Drag to unmark.");
        return true;
      }
      const stroke = buildStudioLassoFrustumStroke(ptsCopy, strokeOp);
      if (!stroke) return false;
      if (Array.isArray(STATE.lassoStrokes) && STATE.lassoStrokes.length > 0) {
        STATE.lassoStrokes.push(stroke);
      } else {
        STATE.lassoStrokes = [stroke];
      }
      STATE.cropPolygonPoints = [];
      STATE.measurePoints = [];
      STATE.polygonLocked = true;
      const selTris = rebuildLassoHighlight3D();
      const totalRegions =
        (Array.isArray(STATE.lassoStrokes) ? STATE.lassoStrokes.filter((s) => s.op !== "sub").length : 0) +
        (Array.isArray(STATE.pendingCropPolygons) ? STATE.pendingCropPolygons.length : 0);
      const canRestoreGap =
        isDelete &&
        !STATE.multiAlign?.active &&
        ((Array.isArray(STATE.activeScan?.merged_from) && STATE.activeScan.merged_from.length > 0) ||
          Boolean(STATE.activeScan?.derived_from_scan_id));
      showToast(
        selTris > 0
          ? `${isDelete ? "Marked for Deletion" : "Marked to Keep"}: ${totalRegions} region${
              totalRegions === 1 ? "" : "s"
            } (${selTris.toLocaleString()} tris) · Mark more or press ${isDelete ? "Delete" : "Apply Crop"}`
          : canRestoreGap
          ? `Gap region marked (${totalRegions}) — press '🩹 Restore Deleted Area' to patch missing geometry, or zoom closer to select triangles`
          : "No visible triangles inside lasso — zoom closer or uncheck 'Protect Occluded Background'"
      );
      if (isDelete) {
        openLassoDeleteInspector({ armLasso: true });
      } else {
        openLassoKeepInspector({ armLasso: true });
      }
      if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
      return true;
    };

    const applyChordedMiddleOrbitDelta = (dx, dy) => {
      if (!dx && !dy) return;
      const el = renderer.domElement;
      const h = Math.max(1, el.clientHeight || 600);
      const rotSpeed = 2 * Math.PI * (controls.rotateSpeed || 1.0);
      const dTheta = -(dx / h) * rotSpeed;
      const dPhi = -(dy / h) * rotSpeed;
      const offset = camera.position.clone().sub(controls.target);
      const sph = new THREE.Spherical().setFromVector3(offset);
      sph.theta += dTheta;
      sph.phi = Math.max(0.02, Math.min(Math.PI - 0.02, sph.phi + dPhi));
      offset.setFromSpherical(sph);
      camera.position.copy(controls.target).add(offset);
      camera.lookAt(controls.target);
      controls.update();
    };

    // Suppress right-click context menu on canvas while First-Person Mode is active (or immediately after right-drag release)
    let _lastFpRightDragTs = 0;
    renderer.domElement.addEventListener("contextmenu", (e) => {
      if ((STATE.activeView === "studio" && STATE.fpMode.active) || performance.now() - _lastFpRightDragTs < 400) {
        e.preventDefault();
      }
    });

    // Mouse Wheel adjusts First-Person movement speed smoothly (Unreal / Blender style)
    renderer.domElement.addEventListener(
      "wheel",
      (e) => {
        if (STATE.activeView !== "studio" || !STATE.fpMode.active) return;
        e.preventDefault();
        e.stopPropagation();
        const factor = e.deltaY < 0 ? 1.16 : 1 / 1.16;
        const nextSpeed = Math.max(0.5, Math.min(60.0, Number((STATE.fpMode.baseSpeed * factor).toFixed(2))));
        STATE.fpMode.baseSpeed = nextSpeed;
        syncFirstPersonHudUI();
      },
      { passive: false }
    );

    // Double-click on 3D surface in First-Person Mode teleports smoothly above that point
    renderer.domElement.addEventListener("dblclick", (e) => {
      if (STATE.activeView !== "studio" || !STATE.fpMode.active) return;
      if (STATE.activeTool !== "orbit" && STATE.activeTool !== "align_merge") return;
      const rect = renderer.domElement.getBoundingClientRect();
      const qx = document.pointerLockElement === renderer.domElement ? rect.left + rect.width * 0.5 : e.clientX;
      const qy = document.pointerLockElement === renderer.domElement ? rect.top + rect.height * 0.5 : e.clientY;
      const hit = pickStudio3DHit(qx, qy);
      if (hit && hit.rawPoint) {
        const hOffset = STATE.fpMode.locomotion === "walk" ? STATE.fpMode.eyeHeight : 1.75;
        camera.position.set(hit.rawPoint.x, hit.rawPoint.y + hOffset, hit.rawPoint.z);
        STATE.fpMode.velX = 0;
        STATE.fpMode.velY = 0;
        STATE.fpMode.velZ = 0;
        if (STATE.fpMode.locomotion === "walk") STATE.fpMode.onGround = true;
        showToast(tr("已瞬移至目標位置", "Teleported to target position"));
      }
    });

    // Pointer click & live rubberband preview handler for 3D Measurements & Tools
    let downPos = { x: 0, y: 0 };
    const activeTouchPointers = new Set();
    let lastMultiTouchTime = 0;

    renderer.domElement.addEventListener(
      "touchstart",
      (te) => {
        if (te.touches && te.touches.length >= 2) {
          lastMultiTouchTime = performance.now();
          if (_lassoState.dragging) {
            cancelActiveLassoDrag();
          }
        }
      },
      { passive: true }
    );
    renderer.domElement.addEventListener(
      "touchmove",
      (te) => {
        if (te.touches && te.touches.length >= 2) {
          lastMultiTouchTime = performance.now();
          if (_lassoState.dragging) {
            cancelActiveLassoDrag();
          }
        }
      },
      { passive: true }
    );

    renderer.domElement.addEventListener("pointerdown", (e) => {
      document.querySelectorAll(".gs-scan-comment-pin.mobile-open").forEach((el) => el.classList.remove("mobile-open"));
      if (e.pointerType === "touch") {
        activeTouchPointers.add(e.pointerId);
        if (activeTouchPointers.size >= 2) {
          lastMultiTouchTime = performance.now();
          if (_lassoState.dragging) {
            cancelActiveLassoDrag(e);
          }
          return;
        }
      }
      downPos = { x: e.clientX, y: e.clientY };
      if (
        STATE.activeView === "studio" &&
        STATE.multiAlign.active &&
        STATE.activeTool === "align_merge" &&
        document.pointerLockElement !== renderer.domElement &&
        e.button === 0
      ) {
        if (handleGizmoPointerDown(e)) return;
      }
      if (STATE.activeView === "studio" && STATE.fpMode.active) {
        if (
          document.pointerLockElement !== renderer.domElement &&
          (e.button === 0 || e.button === 1 || e.button === 2 || e.pointerType === "touch")
        ) {
          if (e.button === 2) _lastFpRightDragTs = performance.now();
          STATE.fpMode.dragLooking = true;
          STATE.fpMode.lookPointerId = e.pointerId;
          STATE.fpMode.dragLastX = e.clientX;
          STATE.fpMode.dragLastY = e.clientY;
          STATE.fpMode.dragDist = 0;
          try {
            renderer.domElement.setPointerCapture(e.pointerId);
          } catch (_) {}
        }
        return;
      }
      if (STATE.activeView === "studio" && STATE.multiAlign.active && STATE.activeTool === "align_merge") {
        if (handleGizmoPointerDown(e)) return;
      }
      if (STATE.activeView === "studio" && STATE.activeTool === "section" && e.button === 0) {
        if (typeof handleSectionBoxGizmoPointerDown === "function" && handleSectionBoxGizmoPointerDown(e)) return;
      }
      // Multi-touch safety: if a second finger touches down while lassoing, cancel lasso so pinch-zoom/orbit works
      if (_lassoState.dragging && (e.pointerId !== _lassoState.pointerId || activeTouchPointers.size >= 2)) {
        lastMultiTouchTime = performance.now();
        cancelActiveLassoDrag(e);
        return;
      }
      // Middle mouse button (e.button === 1) ALWAYS orbits via OrbitControls!
      if (e.button === 1) {
        if (_lassoState.dragging) {
          cancelActiveLassoDrag(e);
        }
        if (controls) {
          controls.enabled = true;
          controls.enableRotate = true;
          controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
        }
        return;
      }
      // Direct click-and-drag on editable vertices (especially closed Area polygon points & completed measurement points)
      if (
        e.button === 0 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !STATE.movingVertex &&
        activeTouchPointers.size < 2 &&
        STATE.activeView === "studio" &&
        STATE.activeTool !== "crop" &&
        STATE.activeTool !== "crop_delete" &&
        !(Array.isArray(STATE.measurePoints) && STATE.measurePoints.length > 0) &&
        typeof findNearestEditableVertexAtScreenXY === "function" &&
        typeof startStudioVertexMove === "function"
      ) {
        const nearV = findNearestEditableVertexAtScreenXY(
          e.clientX,
          e.clientY,
          window.innerWidth <= 768 ? 30 : 22
        );
        if (
          nearV &&
          (nearV.measType === "area" ||
            STATE.activeTool === "area" ||
            STATE.activeTool === nearV.measType ||
            STATE.activeTool === "orbit")
        ) {
          if (startStudioVertexMove(nearV, { dragMode: true, pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY })) {
            if (controls) {
              controls.mouseButtons.LEFT = -1;
            }
            if (renderer.domElement) {
              renderer.domElement.style.cursor = "grabbing";
              try {
                renderer.domElement.setPointerCapture(e.pointerId);
              } catch (_) {}
            }
            return;
          }
        }
      }
      if (
        e.button === 0 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !STATE.studioLassoOrbitMode &&
        activeTouchPointers.size < 2 &&
        STATE.activeView === "studio" &&
        (STATE.activeTool === "crop_delete" || STATE.activeTool === "crop") &&
        STATE.lassoInputMethod !== "polygon"
      ) {
        syncStudioControlsForTool();
        const rect = renderer.domElement.getBoundingClientRect();
        _lassoState.dragging = true;
        _lassoState.pointerId = e.pointerId;
        _lassoState.op = e.altKey ? "sub" : "add";
        _lassoState.totalArcLen = 0;
        _lassoState.chordOrbitActive = false;
        _lassoState.downClient = { x: e.clientX, y: e.clientY };
        _lassoState.screenPts = [{ x: e.clientX - rect.left, y: e.clientY - rect.top, cx: e.clientX, cy: e.clientY }];
        try {
          renderer.domElement.setPointerCapture(e.pointerId);
        } catch (_) {}
        updateLassoSvgVisual();
      }
    });

    renderer.domElement.addEventListener("pointercancel", (e) => {
      if (e.pointerType === "touch") {
        activeTouchPointers.delete(e.pointerId);
      }
      if (STATE.fpMode?.dragLooking && (STATE.fpMode.lookPointerId == null || e.pointerId === STATE.fpMode.lookPointerId)) {
        STATE.fpMode.dragLooking = false;
        STATE.fpMode.lookPointerId = null;
      }
      if (STATE.movingVertex?.dragMode && (STATE.movingVertex.pointerId == null || e.pointerId === STATE.movingVertex.pointerId)) {
        if (typeof cancelStudioVertexMove === "function") cancelStudioVertexMove(false);
        syncStudioControlsForTool();
      }
      if ((_lassoState.dragging || _lassoState.chordOrbitActive) && (_lassoState.pointerId === null || e.pointerId === _lassoState.pointerId)) {
        cancelActiveLassoDrag(e);
      }
    });

    renderer.domElement.addEventListener("lostpointercapture", (e) => {
      if (e.pointerType === "touch") {
        activeTouchPointers.delete(e.pointerId);
      }
      if (_lassoState.dragging && (_lassoState.pointerId === null || e.pointerId === _lassoState.pointerId)) {
        cancelActiveLassoDrag(e);
      }
    });

    renderer.domElement.addEventListener("pointerup", (e) => {
      if (e.pointerType === "touch") {
        if (activeTouchPointers.size >= 2) {
          lastMultiTouchTime = performance.now();
        }
        activeTouchPointers.delete(e.pointerId);
      }
      if (
        STATE.movingVertex?.dragMode &&
        (e.button === 0 || e.pointerType === "touch") &&
        (STATE.movingVertex.pointerId == null || e.pointerId === STATE.movingVertex.pointerId)
      ) {
        try {
          renderer.domElement.releasePointerCapture(e.pointerId);
        } catch (_) {}
        const dragDistPx = Math.hypot(
          e.clientX - (STATE.movingVertex.startClientX ?? downPos.x),
          e.clientY - (STATE.movingVertex.startClientY ?? downPos.y)
        );
        if (dragDistPx >= 4 || STATE.movingVertex.hasMoved) {
          const moveHit = pickStudio3DHit(e.clientX, e.clientY);
          if (typeof commitStudioVertexMove === "function") {
            commitStudioVertexMove(moveHit ? moveHit.point : null);
          }
          syncStudioControlsForTool();
          return;
        }
        // User clicked without dragging: convert to sticky click-move-click mode
        STATE.movingVertex.dragMode = false;
        STATE.movingVertex.pointerId = null;
        STATE.movingVertex.startedAt = performance.now();
        syncStudioControlsForTool();
        return;
      }
      if (handleGizmoPointerUp(e)) return;
      if (typeof handleSectionBoxGizmoPointerUp === "function" && handleSectionBoxGizmoPointerUp(e)) return;
      if (STATE.activeView === "studio" && STATE.fpMode.active) {
        const wasDragDist = STATE.fpMode.dragDist || 0;
        if (e.button === 2) _lastFpRightDragTs = performance.now();
        if (STATE.fpMode.dragLooking && (STATE.fpMode.lookPointerId == null || e.pointerId === STATE.fpMode.lookPointerId)) {
          STATE.fpMode.dragLooking = false;
          STATE.fpMode.lookPointerId = null;
          try {
            renderer.domElement.releasePointerCapture(e.pointerId);
          } catch (_) {}
        }
        if (e.button !== 0 && e.pointerType !== "touch") return;
        const isLocked = document.pointerLockElement === renderer.domElement;
        if (!isLocked && (wasDragDist > 5 || performance.now() - lastMultiTouchTime < 280)) return;
        if (isLocked) {
          if (STATE.activeTool && STATE.activeTool !== "orbit" && STATE.activeTool !== "align_merge") {
            const rect = renderer.domElement.getBoundingClientRect();
            handleStudioCanvasClick({
              clientX: rect.left + rect.width * 0.5,
              clientY: rect.top + rect.height * 0.5,
            });
          }
          return;
        }
        // Unlocked single left-click: allow Multi-Align layer selection when in align_merge, engage Pointer Lock on desktop mouse in orbit, or place measurement point
        if (STATE.multiAlign.active && STATE.activeTool === "align_merge") {
          if (handleMultiAlignCanvasClick(e)) return;
          return;
        }
        if (!STATE.activeTool || STATE.activeTool === "orbit") {
          if (e.pointerType !== "touch") {
            requestStudioPointerLock();
          }
        } else {
          handleStudioCanvasClick(e);
        }
        return;
      }
      if (_lassoState.chordOrbitActive && (e.buttons & 4) === 0) {
        _lassoState.chordOrbitActive = false;
        if (_lassoState.pointerId !== null && (e.buttons & 1) === 0) {
          cancelActiveLassoDrag(e);
          return;
        }
      }
      if (_lassoState.dragging && e.button === 0 && (_lassoState.pointerId === null || e.pointerId === _lassoState.pointerId)) {
        if (performance.now() - lastMultiTouchTime < 280 || activeTouchPointers.size >= 1) {
          cancelActiveLassoDrag(e);
          return;
        }
        const ptsCopy = _lassoState.screenPts.slice();
        const arcLen = _lassoState.totalArcLen;
        const strokeOp = _lassoState.op;
        cancelActiveLassoDrag(e);

        if (finalizeLassoStrokePoints(ptsCopy, arcLen, strokeOp)) {
          return;
        }
        // Never fall through to single-click point placement if user dragged the cursor at all
        if (arcLen >= 6) return;
      }
      if (handleGizmoPointerUp(e)) return;
      if (typeof handleSectionBoxGizmoPointerUp === "function" && handleSectionBoxGizmoPointerUp(e)) return;
      if (e.button !== 0) return;
      if (performance.now() - lastMultiTouchTime < 280 || activeTouchPointers.size > 0) return;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) >= 8) return;
      if (STATE.activeView === "studio" && STATE.multiAlign.active && STATE.activeTool === "align_merge") {
        if (handleMultiAlignCanvasClick(e)) return;
      }
      handleStudioCanvasClick(e);
    });

    renderer.domElement.addEventListener("pointermove", (e) => {
      if (STATE.activeView !== "studio") return;
      if (
        STATE.multiAlign.active &&
        STATE.activeTool === "align_merge" &&
        document.pointerLockElement !== renderer.domElement &&
        !STATE.fpMode.dragLooking
      ) {
        if (handleGizmoPointerMove(e)) return;
      }
      if (
        STATE.activeTool === "section" &&
        document.pointerLockElement !== renderer.domElement &&
        !STATE.fpMode.dragLooking &&
        typeof handleSectionBoxGizmoPointerMove === "function"
      ) {
        if (handleSectionBoxGizmoPointerMove(e)) return;
      }
      if (STATE.fpMode.active) {
        if (document.pointerLockElement === renderer.domElement) {
          // Handled via document mousemove for raw movementX / movementY
          return;
        }
        const isTrackedTouch = e.pointerType === "touch" && STATE.fpMode.lookPointerId === e.pointerId;
        const isSamePointer = STATE.fpMode.lookPointerId == null || STATE.fpMode.lookPointerId === e.pointerId;
        if (STATE.fpMode.dragLooking && isSamePointer && ((e.buttons & 7) !== 0 || isTrackedTouch)) {
          if ((e.buttons & 2) !== 0) _lastFpRightDragTs = performance.now();
          const dx = e.clientX - STATE.fpMode.dragLastX;
          const dy = e.clientY - STATE.fpMode.dragLastY;
          STATE.fpMode.dragLastX = e.clientX;
          STATE.fpMode.dragLastY = e.clientY;
          STATE.fpMode.dragDist += Math.hypot(dx, dy);
          applyFirstPersonLookDelta(dx, dy, e.pointerType === "touch" ? 0.0034 : 0.0028);
          return;
        }
        if (isSamePointer) {
          STATE.fpMode.dragLooking = false;
          STATE.fpMode.lookPointerId = null;
        }
      }
      if (STATE.movingVertex?.dragMode && typeof updateStudioVertexMove === "function") {
        if ((e.buttons & 1) !== 0 || e.pointerType === "touch") {
          STATE.movingVertex.hasMoved = true;
          const moveHit = pickStudio3DHit(e.clientX, e.clientY);
          if (moveHit && moveHit.point) {
            updateStudioVertexMove(moveHit.point);
            const twd = localToTwd97(moveHit.point);
            const lbl = document.getElementById("lblLastPickedCoord");
            if (lbl) {
              lbl.textContent = formatScanCoordReadout(twd, STATE.activeScan);
            }
          }
          return;
        }
      }
      if (_lassoState.chordOrbitActive) {
        if ((e.buttons & 4) !== 0) {
          applyChordedMiddleOrbitDelta(e.clientX - _lassoState.chordLastX, e.clientY - _lassoState.chordLastY);
          _lassoState.chordLastX = e.clientX;
          _lassoState.chordLastY = e.clientY;
          return;
        }
        _lassoState.chordOrbitActive = false;
        if ((e.buttons & 1) === 0) {
          cancelActiveLassoDrag(e);
          return;
        }
        if (
          STATE.activeView === "studio" &&
          (STATE.activeTool === "crop_delete" || STATE.activeTool === "crop") &&
          STATE.lassoInputMethod !== "polygon"
        ) {
          const rect = renderer.domElement.getBoundingClientRect();
          _lassoState.dragging = true;
          _lassoState.op = e.altKey ? "sub" : "add";
          _lassoState.totalArcLen = 0;
          _lassoState.screenPts = [{ x: e.clientX - rect.left, y: e.clientY - rect.top, cx: e.clientX, cy: e.clientY }];
          updateLassoSvgVisual();
          return;
        }
      }
      if (_lassoState.dragging) {
        if (_lassoState.pointerId !== null && e.pointerId !== _lassoState.pointerId) return;
        // If user presses Middle Mouse Wheel ((e.buttons & 4) !== 0) mid-drag, commit any valid loop & immediately rotate!
        if (e.pointerType === "mouse" && (e.buttons & 4) !== 0) {
          const ptsCopy = _lassoState.screenPts.slice();
          const arcLen = _lassoState.totalArcLen;
          const strokeOp = _lassoState.op;
          _lassoState.dragging = false;
          _lassoState.screenPts = [];
          _lassoState.totalArcLen = 0;
          updateLassoSvgVisual();
          if (ptsCopy.length >= 4 && arcLen >= 24) {
            finalizeLassoStrokePoints(ptsCopy, arcLen, strokeOp);
          }
          _lassoState.chordOrbitActive = true;
          _lassoState.chordLastX = e.clientX;
          _lassoState.chordLastY = e.clientY;
          return;
        }
        if (e.pointerType === "mouse" && (e.buttons & 1) === 0) {
          cancelActiveLassoDrag(e);
          return;
        }
        const rect = renderer.domElement.getBoundingClientRect();
        const nx = e.clientX - rect.left;
        const ny = e.clientY - rect.top;
        const last = _lassoState.screenPts[_lassoState.screenPts.length - 1];
        const seg = last ? Math.hypot(nx - last.x, ny - last.y) : 999;
        if (!last || seg >= 4) {
          if (last) _lassoState.totalArcLen += seg;
          _lassoState.screenPts.push({ x: nx, y: ny, cx: e.clientX, cy: e.clientY });
          updateLassoSvgVisual();
        }
        return;
      }
      if (STATE.multiAlign.active && STATE.activeTool === "align_merge") {
        if (handleGizmoPointerMove(e)) return;
      }
      if (STATE.activeTool === "section" && typeof handleSectionBoxGizmoPointerMove === "function") {
        if (handleSectionBoxGizmoPointerMove(e)) return;
      }
      // Do not run hover raycasts while orbiting/panning with mouse buttons held down
      if ((e.buttons & 7) !== 0) return;

      if (STATE.movingVertex && typeof updateStudioVertexMove === "function") {
        const moveHit = pickStudio3DHit(e.clientX, e.clientY);
        if (moveHit && moveHit.point) {
          updateStudioVertexMove(moveHit.point);
          const twd = localToTwd97(moveHit.point);
          const lbl = document.getElementById("lblLastPickedCoord");
          if (lbl) {
            lbl.textContent = formatScanCoordReadout(twd, STATE.activeScan);
          }
        }
        return;
      }

      if (
        typeof findNearestEditableVertexAtScreenXY === "function" &&
        STATE.activeTool !== "crop" &&
        STATE.activeTool !== "crop_delete" &&
        !(Array.isArray(STATE.measurePoints) && STATE.measurePoints.length > 0)
      ) {
        const nearHoverV = findNearestEditableVertexAtScreenXY(
          e.clientX,
          e.clientY,
          window.innerWidth <= 768 ? 30 : 22
        );
        if (
          nearHoverV &&
          (nearHoverV.measType === "area" ||
            STATE.activeTool === "area" ||
            STATE.activeTool === nearHoverV.measType ||
            STATE.activeTool === "orbit")
        ) {
          if (renderer.domElement && renderer.domElement.style.cursor !== "grab") {
            renderer.domElement.style.cursor = "grab";
          }
        } else if (renderer.domElement && renderer.domElement.style.cursor === "grab") {
          renderer.domElement.style.cursor = "";
        }
      }

      if (STATE.activeTool === "laser") {
        handleStudioLaserMove(e);
      } else if (STATE.activeTool === "coordinates") {
        handleStudioCoordinateMove(e);
      } else if (STATE.activeTool === "angle") {
        handleStudioAngleMove(e);
      } else if (STATE.activeTool === "distance") {
        const hoverPt = pickStudio3DPoint(e.clientX, e.clientY);
        if (hoverPt) {
          const twd = localToTwd97(hoverPt);
          const lbl = document.getElementById("lblLastPickedCoord");
          if (lbl) {
            lbl.textContent = formatScanCoordReadout(twd, STATE.activeScan);
          }
          if (STATE.measurePoints.length === 1) {
            renderDistanceVisuals(hoverPt, null);
          }
        }
      } else if (
        (STATE.activeTool === "volume" ||
          STATE.activeTool === "area" ||
          STATE.activeTool === "contours" ||
          STATE.activeTool === "crop" ||
          STATE.activeTool === "crop_delete" ||
          (STATE.activeTool === "profile" && STATE.measurePoints.length === 1) ||
          (STATE.activeTool === "section" && STATE.measurePoints.length === 1)) &&
        STATE.measurePoints.length >= 1
      ) {
        const hoverPt = pickStudio3DPoint(e.clientX, e.clientY);
        if (hoverPt) {
          renderPolygonRubberband(hoverPt);
          if (STATE.activeTool === "profile" && STATE.measurePoints.length === 1) {
            const dAB = STATE.measurePoints[0].distanceTo(hoverPt);
            const lbl = document.getElementById("lblLastPickedCoord");
            if (lbl) {
              const twd = localToTwd97(hoverPt);
              lbl.textContent = `SECTION A→B: ${dAB.toFixed(2)}m | ${formatScanCoordReadout(twd, STATE.activeScan)}`;
            }
          }
        }
      }
    });

    renderer.domElement.addEventListener("pointerleave", () => {
      if (STATE.activeView !== "studio") return;
      if (
        STATE.activeTool === "coordinates" ||
        STATE.activeTool === "laser" ||
        (STATE.activeTool === "angle" && STATE.measurePoints.length === 0)
      ) {
        clearTempDistanceVisuals();
      }
    });

    const animate = (nowMs) => {
      requestAnimationFrame(animate);
      if (STATE.activeView !== "studio") return;
      if (STATE.fpMode.active) {
        updateFirstPersonCamera(nowMs || performance.now());
      } else {
        controls.update();
      }
      camera.updateMatrixWorld();
      if (studioThree.tilesRenderer && studioThree.modelPivot.visible) {
        studioThree.tilesRenderer.update();
        syncTilesLoaderProgress(studioThree, "studio");
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
      if (STATE.multiAlign.active && studioThree.multiAlignGroup.visible) {
        updateMultiAlignLayersEachFrame();
      }
      updateStudioTransformGizmo();
      updateZoomInvariantElements();
      updateNorthArrowCompass(camera);
      renderer.render(scene, camera);
      update2DBadgePositions();
    };
    requestAnimationFrame(animate);

    return studioThree;
  }

  const _northCompassDir = new THREE.Vector3();
  function updateNorthArrowCompass(overrideCam = null) {
    const rotor = document.getElementById("gsNorthArrowRotor");
    if (!rotor) return;
    let cam = overrideCam;
    if (!cam) {
      if (STATE.activeView === "studio" && studioThree?.camera) {
        cam = studioThree.camera;
      } else if (STATE.activeView === "compare" && typeof compareCtx !== "undefined" && compareCtx?.left?.camera) {
        cam = compareCtx.left.camera;
      } else if (STATE.activeView === "map" && STATE.siteTimelineOpen && typeof previewThree !== "undefined" && previewThree?.camera) {
        cam = previewThree.camera;
      }
    }
    if (!cam) {
      rotor.setAttribute("transform", "rotate(0 18 18)");
      return;
    }
    cam.getWorldDirection(_northCompassDir);
    const camAzDeg = (Math.atan2(_northCompassDir.x, -_northCompassDir.z) * 180) / Math.PI;
    if (Number.isFinite(camAzDeg)) {
      rotor.setAttribute("transform", `rotate(${(-camAzDeg).toFixed(1)} 18 18)`);
    }
  }
  window.updateNorthArrowCompass = updateNorthArrowCompass;

  function alignActiveCameraToNorth() {
    let ctx = null;
    if (STATE.activeView === "studio" && studioThree) {
      ctx = studioThree;
    } else if (STATE.activeView === "map" && typeof previewThree !== "undefined" && previewThree) {
      ctx = previewThree;
    } else if (STATE.activeView === "compare" && typeof compareCtx !== "undefined" && compareCtx?.left) {
      ctx = compareCtx.left;
    }
    if (!ctx || !ctx.camera) return;
    if (STATE.activeView === "studio" && STATE.fpMode?.active) {
      STATE.fpMode.yaw = 0;
      return;
    }
    if (ctx.controls && ctx.controls.target) {
      const tgt = ctx.controls.target;
      const offset = ctx.camera.position.clone().sub(tgt);
      const horizDist = Math.max(0.5, Math.hypot(offset.x, offset.z));
      ctx.camera.position.set(tgt.x, tgt.y + offset.y, tgt.z + horizDist);
      ctx.camera.lookAt(tgt);
      ctx.controls.update();
      updateNorthArrowCompass(ctx.camera);
    }
  }

  document.getElementById("gsNorthArrowCompass")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    alignActiveCameraToNorth();
  });

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

  function loadScanIntoStudio(scanId, opts = {}) {
    initStudio3D();
    const scan = STATE.scans.find((s) => s.scan_id === scanId) || STATE.scans[0];
    if (!scan || !studioThree) return;
    const preserveCamera = Boolean(opts && opts.preserveCamera);
    const preserveTools = Boolean(opts && opts.preserveTools);
    const bustCache = Boolean(opts && opts.bustCache);

    if (STATE.fpMode?.active && typeof exitFirstPersonMode === "function") {
      exitFirstPersonMode(true);
    }
    if (STATE.multiAlign?.active && typeof exitMultiScanAlignMode === "function") {
      exitMultiScanAlignMode(false);
    }

    const prevScanId = STATE.activeScanId;
    STATE.activeScanId = scan.scan_id;
    STATE.activeScan = scan;
    if (prevScanId && prevScanId !== scan.scan_id) {
      STATE.targetAttachCommentId = null;
    }

    // Cancel any running background volume calculation and clean up all tool visuals & panels when switching/loading scans
    STATE._volumeCalcSeq = (STATE._volumeCalcSeq || 0) + 1;
    if (typeof hideVolumeProgressHudPill === "function") {
      hideVolumeProgressHudPill();
    }
    if (!preserveTools) {
      STATE.lastVolumeResult = null;
      STATE.lastContoursResult = null;
      STATE.cutFillPolygonPoints = [];
      STATE.maskBoundaryPoints = [];
      STATE.profileEndpoints = [];
      STATE.lastProfileResult = null;
      STATE.sectionBoxEndpoints = [];
      STATE.sectionBoxState = null;
      STATE.keepSectionBoxClip = true;
      studioThree._laserSpatialIndex = null;
      if (studioThree.contourGroup) {
        while (studioThree.contourGroup.children.length > 0) {
          const c = studioThree.contourGroup.children[0];
          if (c.geometry) c.geometry.dispose();
          if (c.material) c.material.dispose();
          studioThree.contourGroup.remove(c);
        }
      }
      if (typeof clearMeasurements === "function") {
        clearMeasurements();
      }
      if (typeof clearProfileVisualsOnly === "function") {
        clearProfileVisualsOnly();
      }
      if (typeof clearSectionBoxClippingIfNotKept === "function") {
        clearSectionBoxClippingIfNotKept();
      }
      if (typeof clearDrainageVisuals3D === "function") {
        clearDrainageVisuals3D();
      }
      if (typeof clearGcpQaMarkers3D === "function") {
        clearGcpQaMarkers3D();
      }
      if (typeof clearPhotoTargetVisuals3D === "function") {
        clearPhotoTargetVisuals3D(true);
      }
      STATE.categorizeOverlayVisible = false;
      STATE.categorizeLabelsVisible = true;
      if (typeof hideCategorizeOverlaysAndLabels === "function") {
        hideCategorizeOverlaysAndLabels();
      } else if (typeof clearCategorizeVisualsOnly === "function") {
        clearCategorizeVisualsOnly();
      }
      if (typeof closeSidePanel === "function") {
        closeSidePanel();
      }
      if (typeof setActiveStudioTool === "function") {
        setActiveStudioTool("orbit");
      }
    }
    SHARE_TELEMETRY.recordScanViewed(scan, "studio");
    if (STATE.activeProjectGroup !== "__all__") {
      STATE.activeProjectGroup = scan.project_group || "Unassigned Site";
    }

    // Filter active scan dropdown strictly to this project's scans (Fix #4)
    populateProjectScanDropdowns(scan.project_group || "Unassigned Site", scan.scan_id);

    const sel = document.getElementById("studioScanSelect");
    if (sel) sel.value = scan.scan_id;

    updateStudioScanMetricsReadout(scan);

    const pickedEl = document.getElementById("lblLastPickedCoord");
    if (pickedEl) {
      if (inferActiveScanCrsCode(scan) === "LOCAL_ORIGIN") {
        pickedEl.textContent = tr("局部原點 · 點擊 3D 表面以檢視座標", "Local Origin · Click 3D surface to inspect");
      } else {
        pickedEl.textContent = formatScanCoordReadout(
          {
            e: Number(scan.twd97_e || 0),
            n: Number(scan.twd97_n || 0),
            h: Number(scan.twd97_h || 0),
          },
          scan
        );
      }
    }

    const dlBtn = document.getElementById("btnStudioDownloadObj");
    if (dlBtn) {
      dlBtn.href = appendAuthToDownloadUrl(
        scan.download_obj_url || `/api/download?scan_id=${encodeURIComponent(scan.scan_id)}&type=obj`
      );
    }
    if (typeof closeQuickSingleScanSharePopover === "function") {
      closeQuickSingleScanSharePopover();
    }

    // Clear any stale scan-editing lasso selection & staged preview when loading a scan
    if (typeof clearLassoSelectionState === "function") {
      clearLassoSelectionState();
    }
    if (typeof clearPhotoTargetVisuals3D === "function") {
      clearPhotoTargetVisuals3D(true);
    }
    STATE.lastInspectedPhotos = [];
    STATE.lastInspectedPhotoTargetPt = null;
    STATE.lastInspectedPhotoTargetTwd = null;
    STATE.categorizeOverlayVisible = STATE.activeTool === "categorize";
    if (STATE.categorizeLabelsVisible === undefined || STATE.categorizeLabelsVisible === null) {
      STATE.categorizeLabelsVisible = true;
    }
    if (typeof clearCategorizeVisualsOnly === "function") {
      clearCategorizeVisualsOnly();
    }
    if (typeof syncCategorizeVisibilityUI === "function") {
      syncCategorizeVisibilityUI();
    }
    if (typeof preloadSavedCategorizationForScan === "function") {
      preloadSavedCategorizationForScan(scan.scan_id, scan, { renderWhenLoaded: STATE.activeTool === "categorize" });
    }
    if (typeof resetStagedEditsForScan === "function") {
      resetStagedEditsForScan(scan);
    }

    const hasValidPrevCenter =
      preserveCamera &&
      prevScanId === scan.scan_id &&
      Array.isArray(studioThree.tilesCenter) &&
      Math.hypot(
        Number(studioThree.tilesCenter[0]) || 0,
        Number(studioThree.tilesCenter[1]) || 0,
        Number(studioThree.tilesCenter[2]) || 0
      ) > 1e-3;
    const prevTilesCenter = hasValidPrevCenter ? studioThree.tilesCenter.slice() : null;
    const prevCamPos = hasValidPrevCenter && studioThree.camera ? studioThree.camera.position.clone() : null;
    const prevCamTarget = hasValidPrevCenter && studioThree.controls ? studioThree.controls.target.clone() : null;

    // Teardown previous tilesRenderer / mesh and free GPU VRAM before loading next scan
    if (typeof suspendPreview3DResources === "function" && STATE.activeView === "studio") {
      suspendPreview3DResources();
    }
    if (studioThree.tilesRenderer) {
      studioThree.modelPivot.remove(studioThree.tilesRenderer.group);
      studioThree.tilesRenderer.dispose();
      studioThree.tilesRenderer = null;
    }
    disposeObject3DResources(studioThree.modelPivot);
    while (studioThree.modelPivot.children.length > 0) {
      studioThree.modelPivot.remove(studioThree.modelPivot.children[0]);
    }
    studioThree.modelPivot.rotation.set(0, 0, 0);
    studioThree.modelPivot.updateMatrixWorld(true);
    studioThree.tilesCenter = [0, 0, 0];
    studioThree.tileUpMatrix = new THREE.Matrix4();
    if (studioThree.fallbackGroup) studioThree.fallbackGroup.visible = false;

    if (scan.status && scan.status !== "completed" && !scan.stream_url) {
      if (studioThree.fallbackGroup) studioThree.fallbackGroup.visible = true;
      frameStudioCamera();
      const pendingMsg =
        scan.status === "processing"
          ? `Processing in PIX4Dmatic (${Math.round(scan.progress_pct || 0)}%) — ${scan.stage_label || ""}`
          : scan.status === "queued"
          ? `Queued for PIX4Dmatic — ${scan.stage_label || "Waiting in Queue"}`
          : scan.status === "waiting_parts"
          ? `Waiting for Split Upload Parts — ${scan.stage_label || ""}`
          : typeof window.formatPendingScanStatusMessage === "function"
          ? window.formatPendingScanStatusMessage(scan)
          : `Status: ${scan.status}`;
      finishScanLoader(studioThree, "studio", pendingMsg);
      return;
    }

    startScanLoader(studioThree, "studio", scan.name, scan.scan_id);

    const isIOS = typeof isIOSOrIPadDevice === "function" && isIOSOrIPadDevice();
    const isMobOrTab = isIOS || (typeof isMobileOrTabletDevice === "function" && isMobileOrTabletDevice());
    const lodMode = STATE.scanLodMode || "auto";
    const useLowMemTileset =
      !opts.forceFullRes &&
      (Boolean(studioThree._forceLowMemStream) ||
        (isIOS && lodMode === "rough"));

    let streamUrl = scan.stream_url || `/stream/${scan.scan_id}/tileset.json`;
    if (useLowMemTileset && scan.stream_type !== "glb" && !streamUrl.toLowerCase().endsWith(".glb")) {
      streamUrl =
        scan.preview_stream_url ||
        streamUrl.replace("/tileset.json", "/preview_tileset.json");
    }
    studioThree._loadedLowMemTileset = Boolean(useLowMemTileset);
    studioThree._loadedTilesetUrl = streamUrl;
    document.querySelectorAll("#studioLodModeSwitcher [data-lod-mode]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.lodMode === lodMode);
    });
    if (bustCache) {
      const baseNoQ = streamUrl.split("?")[0];
      streamUrl = `${baseNoQ}?v=${scan.tileset_version || Date.now()}`;
      if (STATE.shareToken && !streamUrl.includes("share=")) {
        streamUrl += `&share=${encodeURIComponent(STATE.shareToken)}`;
      }
    }

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
            studioThree.tilesCenter = [sphere.center.x, sphere.center.y, sphere.center.z];
        if (typeof renderCommentPins3D === "function") renderCommentPins3D();
        if (typeof loadAndRenderScanCameraTrajectory3D === "function" && scan && scan.scan_id) {
          loadAndRenderScanCameraTrajectory3D(scan.scan_id, true);
        }
          }
          studioThree.tileUpMatrix = new THREE.Matrix4();
          if (studioThree.grid) {
            studioThree.grid.position.y = Number.isFinite(box.min.y)
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
          studioThree.modelPivot.add(model);
          studioThree.boundingSphere = sphere;
          if (typeof updateScanGoogleMap3DLayer === "function") {
            updateScanGoogleMap3DLayer(studioThree, scan);
          }
          if (typeof scheduleScanGoogleMapCoverageUpdate === "function") {
            scheduleScanGoogleMapCoverageUpdate(studioThree, scan, 30);
          }
          if (preserveCamera && prevCamPos && prevCamTarget) {
            const dx = prevTilesCenter ? sphere.center.x - prevTilesCenter[0] : 0;
            const dy = prevTilesCenter ? sphere.center.y - prevTilesCenter[1] : 0;
            const dz = prevTilesCenter ? sphere.center.z - prevTilesCenter[2] : 0;
            // modelPivot rotates -90 deg around X: Z-up delta (dx, dy, dz) -> world delta (dx, dz, -dy)
            studioThree.camera.position.set(prevCamPos.x - dx, prevCamPos.y - dz, prevCamPos.z + dy);
            studioThree.controls.target.set(prevCamTarget.x - dx, prevCamTarget.y - dz, prevCamTarget.z + dy);
            studioThree.controls.update();
          } else {
            frameStudioCamera();
          }
          if (
            (STATE.activeTool === "photos" || STATE.activeTool === "rtk") &&
            typeof loadAndRenderScanCameraTrajectory3D === "function"
          ) {
            loadAndRenderScanCameraTrajectory3D(scan.scan_id, true);
          }
          if (
            (STATE.activeTool === "photos" || STATE.activeTool === "rtk") &&
            STATE.lastInspectedPhotoTargetTwd &&
            STATE.lastInspectedPhotos?.length &&
            typeof twd97ToStudioLocalVec === "function"
          ) {
            STATE.lastInspectedPhotoTargetPt = twd97ToStudioLocalVec(
              STATE.lastInspectedPhotoTargetTwd.e,
              STATE.lastInspectedPhotoTargetTwd.n,
              STATE.lastInspectedPhotoTargetTwd.h,
              null,
              null
            );
            if (typeof placePhotoTargetMarker3D === "function") {
              placePhotoTargetMarker3D(STATE.lastInspectedPhotoTargetPt);
            }
            if (typeof renderRtkPhotoFrustums3D === "function") {
              renderRtkPhotoFrustums3D(
                STATE.lastInspectedPhotos,
                STATE.lastInspectedPhotoTargetPt,
                STATE.lastInspectedPhotoTargetTwd
              );
            }
          }
          _lastBadgeOcclusionCamSig = "";
          finishScanLoader(studioThree, "studio", "100% · 3D Mesh Ready");
        },
        (xhr) => {
          const pct =
            xhr && xhr.total > 0
              ? Math.min(95, Math.max(12, Math.round((xhr.loaded / xhr.total) * 100)))
              : Math.min(88, (studioThree._maxPct || 12) + 8);
          studioThree._maxPct = pct;
          updateScanLoader("studio", true, pct, `Loading 3D Mesh (${pct}%)...`);
        },
        (err) => {
          if (studioThree.fallbackGroup) studioThree.fallbackGroup.visible = true;
          finishScanLoader(studioThree, "studio", "Ready");
          console.warn("[GatheringScans] Using reference terrain surface for GLB:", err);
        }
      );
    } else if (window.TilesRenderer) {
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
        if (studioThree.tilesRenderer !== tr) return;
        if (tr._rootCentered) return;
        tr._rootCentered = true;
        studioThree._tilesetReady = true;
        studioThree._tilesetReadyMs = performance.now();
        studioThree._maxPct = Math.max(studioThree._maxPct || 0, 22);
        updateScanLoader("studio", true, studioThree._maxPct, "Streaming 3D tiles...");
        const sphere = new THREE.Sphere();
        if (computeTilesetContentSphere(tr, sphere)) {
          tr.group.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
          studioThree.tilesCenter = [sphere.center.x, sphere.center.y, sphere.center.z];
        if (typeof renderCommentPins3D === "function") renderCommentPins3D();
        if (typeof loadAndRenderScanCameraTrajectory3D === "function" && scan && scan.scan_id) {
          loadAndRenderScanCameraTrajectory3D(scan.scan_id, true);
        }
          studioThree.tileUpMatrix = tr._upRotationMatrix ? tr._upRotationMatrix.clone() : new THREE.Matrix4();
          // Z-up TWD97 tilesets: rotate -90 deg on X so elevation points +Y
          studioThree.modelPivot.rotation.set(THREE.MathUtils.degToRad(270), 0, 0);
          studioThree.modelPivot.updateMatrixWorld(true);
          studioThree.boundingSphere = sphere;
          if (studioThree.grid) {
            if (Number.isFinite(scan._resolvedGroundH)) {
              studioThree.grid.position.y = scan._resolvedGroundH - sphere.center.z - 0.19;
            } else {
              studioThree.grid.position.y = Number.isFinite(sphere._groundOffsetY)
                ? sphere._groundOffsetY
                : -8.0;
            }
          }
          if (typeof updateScanGoogleMap3DLayer === "function") {
            updateScanGoogleMap3DLayer(studioThree, scan);
          }
          if (preserveCamera && prevCamPos && prevCamTarget) {
            const dx = prevTilesCenter ? sphere.center.x - prevTilesCenter[0] : 0;
            const dy = prevTilesCenter ? sphere.center.y - prevTilesCenter[1] : 0;
            const dz = prevTilesCenter ? sphere.center.z - prevTilesCenter[2] : 0;
            // modelPivot rotates -90 deg around X: Z-up delta (dx, dy, dz) -> world delta (dx, dz, -dy)
            studioThree.camera.position.set(prevCamPos.x - dx, prevCamPos.y - dz, prevCamPos.z + dy);
            studioThree.controls.target.set(prevCamTarget.x - dx, prevCamTarget.y - dz, prevCamTarget.z + dy);
            studioThree.controls.update();
          } else {
            frameStudioCamera();
          }
          if (
            STATE.categorizeOverlayVisible &&
            STATE.lastCategorizeResult &&
            STATE.lastCategorizeResult.scan_id === scan.scan_id
          ) {
            renderCategorize3DOverlays(STATE.lastCategorizeResult);
          }
          if (
            (STATE.activeTool === "photos" || STATE.activeTool === "rtk") &&
            typeof loadAndRenderScanCameraTrajectory3D === "function"
          ) {
            loadAndRenderScanCameraTrajectory3D(scan.scan_id, true);
          }
          if (
            (STATE.activeTool === "photos" || STATE.activeTool === "rtk") &&
            STATE.lastInspectedPhotoTargetTwd &&
            STATE.lastInspectedPhotos?.length &&
            typeof twd97ToStudioLocalVec === "function"
          ) {
            STATE.lastInspectedPhotoTargetPt = twd97ToStudioLocalVec(
              STATE.lastInspectedPhotoTargetTwd.e,
              STATE.lastInspectedPhotoTargetTwd.n,
              STATE.lastInspectedPhotoTargetTwd.h,
              null,
              null
            );
            if (typeof placePhotoTargetMarker3D === "function") {
              placePhotoTargetMarker3D(STATE.lastInspectedPhotoTargetPt);
            }
            if (typeof renderRtkPhotoFrustums3D === "function") {
              renderRtkPhotoFrustums3D(
                STATE.lastInspectedPhotos,
                STATE.lastInspectedPhotoTargetPt,
                STATE.lastInspectedPhotoTargetTwd
              );
            }
          }
        }
        studioThree.camera.updateMatrixWorld();
        tr.update();
      });

      tr.addEventListener("load-model", (ev) => {
        if (studioThree.tilesRenderer !== tr) return;
        if (ev && ev.scene) {
          _lastBadgeOcclusionCamSig = "";
          if (studioThree.fallbackGroup) studioThree.fallbackGroup.visible = false;
          ev.scene.traverse((c) => {
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
          studioThree.camera.updateMatrixWorld();
          tr.update();
          if (typeof applyStagedEditsToStudioMeshes === "function" && hasStagedMeshEditsForActiveScan()) {
            applyStagedEditsToStudioMeshes(false);
          }
          if (typeof scheduleScanGoogleMapCoverageUpdate === "function") {
            scheduleScanGoogleMapCoverageUpdate(studioThree, scan, 90);
          }
          studioThree.renderer.render(studioThree.scene, studioThree.camera);
          syncTilesLoaderProgress(studioThree, "studio");
          if (
            (Array.isArray(STATE.lassoStrokes) && STATE.lassoStrokes.length > 0) ||
            (Array.isArray(STATE.pendingCropPolygons) && STATE.pendingCropPolygons.length > 0) ||
            (Array.isArray(STATE.cropPolygonPoints) && STATE.cropPolygonPoints.length >= 3)
          ) {
            clearTimeout(studioThree._lassoHighlightTimer);
            studioThree._lassoHighlightTimer = setTimeout(() => {
              rebuildLassoHighlight3D();
            }, 80);
          }
          if (
            STATE.activeTool === "drainage" &&
            typeof renderDrainageAndSlopeVisuals3D === "function"
          ) {
            clearTimeout(studioThree._drainageLodRefreshTimer);
            studioThree._drainageLodRefreshTimer = setTimeout(() => {
              if (STATE.activeTool === "drainage") {
                renderDrainageAndSlopeVisuals3D({
                  gridSize: Number(STATE.drainageGridSize) || 20,
                  densityPerM2: Number(STATE.drainageDensityPerM2) || 0.25,
                  arrowScale: Number(STATE.drainageArrowScale) || 1.0,
                  showLabels: STATE.drainageShowLabels !== false,
                  excludeWalls: STATE.drainageExcludeWalls !== false,
                });
              }
            }, 350);
          }
        }
      });

      tr.addEventListener("load-error", () => {
        if (
          useLowMemTileset &&
          !opts.forceFullRes &&
          studioThree.tilesRenderer === tr &&
          Number(tr.stats?.loaded || 0) === 0
        ) {
          console.warn("[GatheringScans] Studio preview_tileset.json failed to load; falling back to full tileset.json");
          loadScanIntoStudio(scan.scan_id, Object.assign({}, opts, { forceFullRes: true }));
        }
      });

      if (lodMode === "rough") {
        tr.errorTarget = 1e9;
      } else if (lodMode === "max") {
        tr.errorTarget = 0.8;
      } else {
        tr.errorTarget = isMobOrTab ? 10.0 : 2.0;
      }
      const isLocalHost = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
      if (tr.downloadQueue) tr.downloadQueue.maxJobs = isIOS ? 3 : isMobOrTab ? 4 : isLocalHost ? 16 : (lodMode === "max" ? 6 : 4);
      if (tr.parseQueue) tr.parseQueue.maxJobs = isIOS ? 1 : isMobOrTab ? 2 : 8;
      if (tr.lruCache) {
        if (isMobOrTab) {
          tr.lruCache.maxSize = isIOS ? 24 : 64;
          tr.lruCache.minSize = isIOS ? 10 : 24;
        } else {
          tr.lruCache.maxSize = 6000;
          tr.lruCache.minSize = 4000;
          tr.lruCache.maxBytesSize = 16 * 1024 * 1024 * 1024;
          tr.lruCache.minBytesSize = 12 * 1024 * 1024 * 1024;
        }
      }
      studioThree.modelPivot.add(tr.group);
      studioThree.tilesRenderer = tr;
      studioThree.camera.updateMatrixWorld();
      tr.update();
    }

    renderCommentPins3D();
  }

  function suspendStudio3DResources() {
    if (!studioThree) return;
    if (studioThree._loaderHideTimer) {
      clearTimeout(studioThree._loaderHideTimer);
      studioThree._loaderHideTimer = null;
    }
    if (studioThree.tilesRenderer) {
      try {
        studioThree.modelPivot.remove(studioThree.tilesRenderer.group);
        studioThree.tilesRenderer.dispose();
      } catch (_) {}
      studioThree.tilesRenderer = null;
    }
    if (studioThree.modelPivot) {
      disposeObject3DResources(studioThree.modelPivot);
      while (studioThree.modelPivot.children.length > 0) {
        studioThree.modelPivot.remove(studioThree.modelPivot.children[0]);
      }
    }
    studioThree._loadingDone = true;
    updateScanLoader("studio", false, 100, "");
  }
  window.suspendStudio3DResources = suspendStudio3DResources;

  function computeStudioEffectiveBoundingRadius() {
    if (STATE.multiAlign?.active && Array.isArray(STATE.multiAlign.layers) && STATE.multiAlign.layers.length > 0) {
      let maxExtent = 35;
      STATE.multiAlign.layers.forEach((l) => {
        if (!l.visible) return;
        const offsetDist = Math.hypot(Number(l.tx) || 0, Number(l.ty) || 0, Number(l.tz) || 0);
        const lr = Number(l._sphereRadius) || 45;
        if (offsetDist + lr > maxExtent) maxExtent = offsetDist + lr;
      });
      return maxExtent;
    }
    return Number(studioThree?.boundingSphere?.radius) || 58;
  }

  function frameStudioCamera() {
    if (!studioThree) return;
    if (STATE.fpMode?.active && typeof exitFirstPersonMode === "function") {
      exitFirstPersonMode(true);
    }
    let cx = 0,
      cy = Number.isFinite(studioThree?.boundingSphere?._groundOffsetY)
        ? studioThree.boundingSphere._groundOffsetY * 0.65
        : 0,
      cz = 0;
    let rawR = Number(studioThree?.boundingSphere?.radius) || 58;
    if (STATE.multiAlign?.active && Array.isArray(STATE.multiAlign.layers)) {
      const visLayers = STATE.multiAlign.layers.filter((l) => l && l.visible);
      if (visLayers.length > 0) {
        visLayers.forEach((l) => {
          cx += Number(l.tx) || 0;
          cy += Number(l.ty) || 0;
          cz += Number(l.tz) || 0;
        });
        cx /= visLayers.length;
        cy /= visLayers.length;
        cz /= visLayers.length;
        let maxR = 35;
        visLayers.forEach((l) => {
          const d = Math.hypot((Number(l.tx) || 0) - cx, (Number(l.ty) || 0) - cy, (Number(l.tz) || 0) - cz);
          const lr = Math.min(140, Number(l._sphereRadius) || 48);
          if (d + lr > maxR) maxR = d + lr;
        });
        rawR = maxR;
      }
    }
    const r = Math.max(22, Math.min(280, rawR));
    studioThree.controls.target.set(cx, cy, cz);
    studioThree.camera.position.set(cx + r * 0.7, cy + r * 0.56, cz + r * 0.8);
    studioThree.camera.lookAt(cx, cy, cz);
    studioThree.controls.update();
    studioThree.camera.updateMatrixWorld(true);
    if (STATE.multiAlign?.active && typeof updateMultiAlignLayersEachFrame === "function") {
      updateMultiAlignLayersEachFrame();
    }
  }

  document.getElementById("btnStudioResetCamera")?.addEventListener("click", frameStudioCamera);

  function getScanCrsDisplayLabel(scanObj) {
    const s = scanObj || STATE.activeScan || {};
    const code = inferActiveScanCrsCode(s);
    if (code === "LOCAL_ORIGIN") return "Local Origin (X/Y/Z m)";
    if (code === "WGS84_UTM50N") return "WGS84 UTM 50N";
    if (code === "WGS84_UTM51N") return "WGS84 UTM 51N";
    if (code === "TWD97_119_TWVD2001") return "TWD97 (119) + TWVD2001";
    const raw = String(s.crs || "").trim();
    if (raw && !raw.toUpperCase().includes("3826") && !raw.toUpperCase().includes("TWD97")) {
      return raw;
    }
    return "TWD97 (121) + TWVD2001";
  }

  function formatScanCoordReadout(twd, scanObj = null) {
    const s = scanObj || STATE.activeScan || {};
    const isMulti = Boolean(STATE.multiAlign?.active);
    const code = isMulti ? "TWD97_121_TWVD2001" : inferActiveScanCrsCode(s);
    const eVal = Number(twd?.e || 0);
    const nVal = Number(twd?.n || 0);
    const hVal = Number(twd?.h || 0);
    const hSign = hVal >= 0 ? "+" : "";
    if (code === "LOCAL_ORIGIN") {
      return `X: ${eVal.toFixed(2)}m, Y: ${nVal.toFixed(2)}m, Z: ${hSign}${hVal.toFixed(2)}m`;
    }
    if (code.startsWith("WGS84_UTM")) {
      return `UTM E: ${eVal.toFixed(2)}m, N: ${nVal.toFixed(2)}m, H: ${hSign}${hVal.toFixed(2)}m`;
    }
    return `E: ${eVal.toFixed(2)}m, N: ${nVal.toFixed(2)}m, H: ${hSign}${hVal.toFixed(2)}m`;
  }

  // Analytical 2D conformal Jacobian (rotZ, scaleXY) from srcDef -> tgtDef at (latDeg, lonDeg)
  function computeConformalJacobianJS(latDeg, lonDeg, srcParams, tgtParams) {
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || (Math.abs(latDeg) < 1e-5 && Math.abs(lonDeg) < 1e-5)) {
      return { rotZ: 0, scaleXY: 1.0 };
    }
    const dLat = 20.0 / 110760.0;
    const dLon = 20.0 / Math.max(10000.0, 111320.0 * Math.cos((latDeg * Math.PI) / 180.0));
    const s0 = wgs84ToTransverseMercatorJS(latDeg, lonDeg, srcParams.lon0, srcParams.fe, srcParams.k0, srcParams.fInv);
    const sE = wgs84ToTransverseMercatorJS(latDeg, lonDeg + dLon, srcParams.lon0, srcParams.fe, srcParams.k0, srcParams.fInv);
    const sN = wgs84ToTransverseMercatorJS(latDeg + dLat, lonDeg, srcParams.lon0, srcParams.fe, srcParams.k0, srcParams.fInv);
    const t0 = wgs84ToTransverseMercatorJS(latDeg, lonDeg, tgtParams.lon0, tgtParams.fe, tgtParams.k0, tgtParams.fInv);
    const tE = wgs84ToTransverseMercatorJS(latDeg, lonDeg + dLon, tgtParams.lon0, tgtParams.fe, tgtParams.k0, tgtParams.fInv);
    const tN = wgs84ToTransverseMercatorJS(latDeg + dLat, lonDeg, tgtParams.lon0, tgtParams.fe, tgtParams.k0, tgtParams.fInv);

    const dsx1 = sE.e - s0.e, dsy1 = sE.n - s0.n;
    const dsx2 = sN.e - s0.e, dsy2 = sN.n - s0.n;
    const dtx1 = tE.e - t0.e, dty1 = tE.n - t0.n;
    const dtx2 = tN.e - t0.e, dty2 = tN.n - t0.n;
    const det = dsx1 * dsy2 - dsy1 * dsx2;
    if (Math.abs(det) < 1e-9) return { rotZ: 0, scaleXY: 1.0 };
    const j11 = (dtx1 * dsy2 - dtx2 * dsy1) / det;
    const j21 = (dty1 * dsy2 - dty2 * dsy1) / det;
    const scaleXY = Math.hypot(j11, j21);
    const rotZ = Math.atan2(j21, j11);
    return {
      rotZ: Number.isFinite(rotZ) ? rotZ : 0,
      scaleXY: Number.isFinite(scaleXY) && scaleXY > 0.5 && scaleXY < 2.0 ? scaleXY : 1.0,
    };
  }

  // Convert local Three.js (x, y, z) to active scan CRS (E/X, N/Y, H/Z) using true tilesCenter
  function localToTwd97(pt) {
    if (STATE.multiAlign?.active && STATE.multiAlign?.refCenter) {
      const rc = STATE.multiAlign.refCenter;
      return {
        e: Number((Number(rc.x || 0) + pt.x).toFixed(3)),
        n: Number((Number(rc.y || 0) - pt.z).toFixed(3)),
        h: Number((Number(rc.z || 0) + pt.y).toFixed(3)),
      };
    }
    const s = STATE.activeScan || {};
    const metaE = s.twd97_e !== undefined && s.twd97_e !== null ? Number(s.twd97_e) : 0;
    const metaN = s.twd97_n !== undefined && s.twd97_n !== null ? Number(s.twd97_n) : 0;
    const metaH = s.twd97_h !== undefined && s.twd97_h !== null ? Number(s.twd97_h) : 0;

    const tc = studioThree?.tilesCenter;
    const isTilesetZUp = Boolean(
      studioThree?.tilesRenderer &&
        Array.isArray(tc) &&
        tc.length >= 3 &&
        Math.abs(studioThree?.modelPivot?.rotation?.x || 0) > 0.1
    );
    if (isTilesetZUp) {
      const tcNorm = Math.hypot(tc[0], tc[1], tc[2]);
      // Non-ECEF projected or local tileset coordinates
      if (tcNorm > 1e-5 && tcNorm < 4000000) {
        const dx = pt.x;
        const dy = -pt.z;
        const dz = pt.y;
        // Unwrapped UTM51N tileset paired with TWD97 scan metadata -> apply analytical conformal Jacobian
        if (tc[0] > 345000 && tc[0] <= 415000 && metaE >= 150000 && metaE <= 345000) {
          const jac = computeConformalJacobianJS(
            Number(s.lat || 25.02),
            Number(s.lon || 121.54),
            { lon0: 123.0, fe: 500000.0, k0: 0.9996, fInv: 298.257223563 },
            { lon0: 121.0, fe: 250000.0, k0: 0.9999, fInv: 298.257222101 }
          );
          const cosR = Math.cos(jac.rotZ) * jac.scaleXY;
          const sinR = Math.sin(jac.rotZ) * jac.scaleXY;
          const baseZ = tc[2] < -50 && metaH > -50 ? metaH : tc[2];
          return {
            e: Number((metaE + cosR * dx - sinR * dy).toFixed(3)),
            n: Number((metaN + sinR * dx + cosR * dy).toFixed(3)),
            h: Number((baseZ + dz).toFixed(3)),
          };
        }
        const baseZ = tc[2] < -50 && metaH > -50 ? metaH : tc[2];
        return {
          e: Number((tc[0] + dx).toFixed(3)),
          n: Number((tc[1] + dy).toFixed(3)),
          h: Number((baseZ + dz).toFixed(3)),
        };
      }
    }

    return {
      e: Number((metaE + pt.x).toFixed(3)),
      n: Number((metaN - pt.z).toFixed(3)),
      h: Number((metaH + pt.y).toFixed(3)),
    };
  }

  const _pickNormalMat = new THREE.Matrix3();

  function pickStudio3DHit(clientX, clientY) {
    if (!studioThree) return null;
    const rect = studioThree.renderer.domElement.getBoundingClientRect();
    studioThree.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    studioThree.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    studioThree.raycaster.setFromCamera(studioThree.mouse, studioThree.camera);

    const targets = [];
    if (studioThree.modelPivot && studioThree.modelPivot.visible) {
      studioThree.modelPivot.traverse((c) => {
        if (c.isMesh && isMeshVisibleUnderRoot(c, studioThree.modelPivot)) targets.push(c);
      });
    }
    if (studioThree.multiAlignGroup && studioThree.multiAlignGroup.visible) {
      studioThree.multiAlignGroup.traverse((c) => {
        if (c.isMesh && isMeshVisibleUnderRoot(c, studioThree.multiAlignGroup) && !c.userData?.isAlignBoxHelper) {
          targets.push(c);
        }
      });
    }
    if (studioThree.fallbackGroup && studioThree.fallbackGroup.visible) {
      studioThree.fallbackGroup.traverse((c) => {
        if (c.isMesh && isMeshVisibleUnderRoot(c, studioThree.fallbackGroup)) targets.push(c);
      });
    }

    const rawHits = studioThree.raycaster.intersectObjects(targets, true);
    const activeSbEval = isSectionBoxClippingActive() ? parseSectionBoxForEval(STATE.sectionBoxState) : null;
    const hits = activeSbEval
      ? rawHits.filter((h) => h && h.point && isPointInSectionBox(h.point.x, h.point.y, h.point.z, activeSbEval))
      : rawHits;
    const snappedVertex =
      STATE.snapEnabled && typeof findNearestSnappableToolVertex === "function"
        ? findNearestSnappableToolVertex(clientX, clientY, window.innerWidth <= 768 ? 28 : 24, STATE.movingVertex)
        : null;

    if (snappedVertex && snappedVertex.point) {
      updateStudioSnapIndicator(snappedVertex.point, true);
    } else {
      updateStudioSnapIndicator(null, false);
    }

    if (hits.length > 0) {
      const h0 = hits[0];
      const rawPoint = h0.point.clone();
      const p = rawPoint.clone();
      let snappedToToolVertex = false;
      if (STATE.snapEnabled) {
        if (snappedVertex && snappedVertex.point) {
          p.copy(snappedVertex.point);
          snappedToToolVertex = true;
        } else {
          p.x = Math.round(p.x * 20) / 20;
          p.y = Math.round(p.y * 20) / 20;
          p.z = Math.round(p.z * 20) / 20;
        }
      }
      const normal = new THREE.Vector3(0, 1, 0);
      if (h0.face && h0.object) {
        try {
          _pickNormalMat.getNormalMatrix(h0.object.matrixWorld);
          normal.copy(h0.face.normal).applyMatrix3(_pickNormalMat).normalize();
        } catch (_) {}
      }
      return {
        point: p,
        rawPoint,
        normal,
        distance: h0.distance,
        object: h0.object,
        snappedToToolVertex,
        snappedVertex: snappedVertex || null,
      };
    }

    if (STATE.snapEnabled && snappedVertex && snappedVertex.point) {
      const sp = snappedVertex.point.clone();
      return {
        point: sp,
        rawPoint: sp.clone(),
        normal: new THREE.Vector3(0, 1, 0),
        distance: studioThree.camera ? studioThree.camera.position.distanceTo(sp) : 0,
        object: null,
        snappedToToolVertex: true,
        snappedVertex,
      };
    }
    return null;
  }

  function getAllSnappableToolVertices(excludeMovingVertex = null) {
    const list = [];
    const pushV = (pt, meta) => {
      if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y) || !Number.isFinite(pt.z)) return;
      if (excludeMovingVertex) {
        if (excludeMovingVertex.point === pt) return;
        if (
          excludeMovingVertex.source === meta.source &&
          excludeMovingVertex.measId &&
          excludeMovingVertex.measId === meta.measId &&
          excludeMovingVertex.pointKey === meta.pointKey &&
          excludeMovingVertex.pointIndex === meta.pointIndex
        ) {
          return;
        }
      }
      list.push(Object.assign({ point: pt, editable: meta.editable !== false }, meta));
    };

    (STATE.completedMeasurements || []).forEach((m) => {
      if (!m || typeof m !== "object") return;
      if (m.type === "distance") {
        pushV(m.p1, { source: "completed", measId: m.id, measType: "distance", pointKey: "p1", label: "Distance P1" });
        pushV(m.p2, { source: "completed", measId: m.id, measType: "distance", pointKey: "p2", label: "Distance P2" });
      } else if (m.type === "angle") {
        pushV(m.p1, { source: "completed", measId: m.id, measType: "angle", pointKey: "p1", label: "Angle P1" });
        pushV(m.p2, { source: "completed", measId: m.id, measType: "angle", pointKey: "p2", label: "Angle Vertex P2" });
        pushV(m.p3, { source: "completed", measId: m.id, measType: "angle", pointKey: "p3", label: "Angle P3" });
      } else if (m.type === "coordinates") {
        pushV(m.pt, { source: "completed", measId: m.id, measType: "coordinates", pointKey: "pt", label: m.label || "Coord" });
      } else if (m.type === "area" && Array.isArray(m.points)) {
        m.points.forEach((pt, idx) => {
          pushV(pt, { source: "completed", measId: m.id, measType: "area", pointIndex: idx, label: `Area V${idx + 1}` });
        });
      } else if (m.type === "laser") {
        pushV(m.originPt, { source: "completed", measId: m.id, measType: "laser", pointKey: "originPt", editable: false });
        pushV(m.pA, { source: "completed", measId: m.id, measType: "laser", pointKey: "pA", editable: false });
        pushV(m.pB, { source: "completed", measId: m.id, measType: "laser", pointKey: "pB", editable: false });
        pushV(m.orthoPA, { source: "completed", measId: m.id, measType: "laser", pointKey: "orthoPA", editable: false });
        pushV(m.orthoPB, { source: "completed", measId: m.id, measType: "laser", pointKey: "orthoPB", editable: false });
      }
    });

    if (Array.isArray(STATE.measurePoints)) {
      STATE.measurePoints.forEach((pt, idx) => {
        pushV(pt, {
          source: "measurePoints",
          measId: "__in_progress__",
          measType: STATE.activeTool || "measure",
          pointIndex: idx,
          label: `Point #${idx + 1}`,
          editable: false,
        });
      });
    }

    if (Array.isArray(STATE.cutFillPolygonPoints) && STATE.cutFillPolygonPoints.length > 0 && STATE.measurePoints.length === 0) {
      STATE.cutFillPolygonPoints.forEach((pt, idx) => {
        pushV(pt, {
          source: "cutFillPolygonPoints",
          measId: "__cut_fill__",
          measType: "volume",
          pointIndex: idx,
          label: `Volume V${idx + 1}`,
        });
      });
    }

    if (Array.isArray(STATE.profileEndpoints) && STATE.profileEndpoints.length >= 2) {
      STATE.profileEndpoints.forEach((pt, idx) => {
        pushV(pt, {
          source: "profileEndpoints",
          measId: "__profile__",
          measType: "profile",
          pointIndex: idx,
          label: idx === 0 ? "Profile A" : "Profile B",
        });
      });
    }

    if (Array.isArray(STATE.sectionBoxEndpoints) && STATE.sectionBoxEndpoints.length >= 2) {
      STATE.sectionBoxEndpoints.forEach((pt, idx) => {
        pushV(pt, {
          source: "sectionBoxEndpoints",
          measId: "__section__",
          measType: "section",
          pointIndex: idx,
          label: idx === 0 ? "Section P1" : "Section P2",
        });
      });
    }

    return list;
  }
  window.getAllSnappableToolVertices = getAllSnappableToolVertices;

  function findNearestSnappableToolVertex(clientX, clientY, maxPx = 24, excludeMovingVertex = STATE.movingVertex, onlyEditable = false) {
    if (!studioThree || !studioThree.camera || !studioThree.renderer?.domElement) return null;
    const rect = studioThree.renderer.domElement.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const cam = studioThree.camera;
    const candidates = getAllSnappableToolVertices(excludeMovingVertex);
    let best = null;
    let bestDistPx = maxPx;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (onlyEditable && !c.editable) continue;
      const proj = c.point.clone().project(cam);
      if (proj.z < -1.0 || proj.z > 1.0) continue;
      const sx = (proj.x * 0.5 + 0.5) * w;
      const sy = (-proj.y * 0.5 + 0.5) * h;
      const dPx = Math.hypot(localX - sx, localY - sy);
      if (dPx <= bestDistPx) {
        bestDistPx = dPx;
        best = Object.assign({}, c, { screenDistPx: dPx, screenX: sx, screenY: sy });
      }
    }
    return best;
  }
  window.findNearestSnappableToolVertex = findNearestSnappableToolVertex;

  function findNearestEditableVertexAtScreenXY(clientX, clientY, maxPx = 26) {
    return findNearestSnappableToolVertex(clientX, clientY, maxPx, STATE.movingVertex, true);
  }
  window.findNearestEditableVertexAtScreenXY = findNearestEditableVertexAtScreenXY;

  function updateStudioSnapIndicator(worldPt, isToolVertex = false) {
    if (!studioThree || !studioThree.overlayGroup) return;
    let ring = studioThree._snapIndicatorRing;
    if (!worldPt || !isToolVertex) {
      if (ring) ring.visible = false;
      return;
    }
    if (!ring) {
      const rGeo = new THREE.RingGeometry(0.95, 1.42, 32);
      const rMat = new THREE.MeshBasicMaterial({
        color: 0x10b981,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.96,
      });
      ring = new THREE.Mesh(rGeo, rMat);
      ring.userData.isZoomInvariantRing = true;
      ring.userData.isSnapIndicator = true;
      ring.userData.pixelRadius = 11.5;
      ring.renderOrder = 1005;
      studioThree._snapIndicatorRing = ring;
    }
    if (!ring.parent) {
      studioThree.overlayGroup.add(ring);
    }
    ring.visible = true;
    ring.position.copy(worldPt);
    if (studioThree.camera) {
      ring.quaternion.copy(studioThree.camera.quaternion);
    }
    updateZoomInvariantElements();
  }

  window.updateStudioSnapIndicator = updateStudioSnapIndicator;

  function updateStudioMovingVertexIndicator(worldPt) {
    if (!studioThree || !studioThree.overlayGroup) return;
    let ring = studioThree._movingVertexRing;
    if (!worldPt) {
      if (ring) ring.visible = false;
      return;
    }
    if (!ring) {
      const rGeo = new THREE.RingGeometry(1.05, 1.58, 32);
      const rMat = new THREE.MeshBasicMaterial({
        color: 0xf59e0b,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.98,
      });
      ring = new THREE.Mesh(rGeo, rMat);
      ring.userData.isZoomInvariantRing = true;
      ring.userData.isMovingVertexIndicator = true;
      ring.userData.pixelRadius = 13.0;
      ring.renderOrder = 1006;
      studioThree._movingVertexRing = ring;
    }
    if (!ring.parent) {
      studioThree.overlayGroup.add(ring);
    }
    ring.visible = true;
    ring.position.copy(worldPt);
    if (studioThree.camera) {
      ring.quaternion.copy(studioThree.camera.quaternion);
    }
    updateZoomInvariantElements();
  }

  window.updateStudioMovingVertexIndicator = updateStudioMovingVertexIndicator;

  function pickStudio3DPoint(clientX, clientY) {
    const hit = pickStudio3DHit(clientX, clientY);
    return hit ? hit.point : null;
  }

  const _tmpZoomWorldPos = new THREE.Vector3();
  const _badgeOcclusionRaycaster = new THREE.Raycaster();
  const _badgeOcclusionDir = new THREE.Vector3();
  let _lastBadgeOcclusionCheckMs = 0;
  let _lastBadgeOcclusionCamSig = "";

  function add3DPinMarker(pt, colorHex = 0x0084ff, targetGroup = null, onAddMesh = null) {
    if (!studioThree) return null;
    const grp = targetGroup || studioThree.overlayGroup;
    const emit = typeof onAddMesh === "function" ? onAddMesh : (m) => grp.add(m);
    const isCommentMarker = grp === studioThree.commentPinsGroup;

    const sphereGeo = new THREE.SphereGeometry(1, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      depthTest: !isCommentMarker,
      depthWrite: false,
      polygonOffset: !isCommentMarker,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      transparent: true,
      opacity: 0.95,
    });
    const innerMesh = new THREE.Mesh(sphereGeo, sphereMat);
    innerMesh.position.set(pt.x, pt.y + 0.03, pt.z);
    innerMesh.userData.isZoomInvariantMarker = true;
    innerMesh.userData.pixelRadius = 5.5;
    innerMesh.renderOrder = 1002;
    emit(innerMesh);

    const ringGeo = new THREE.RingGeometry(0.72, 1.08, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthTest: !isCommentMarker,
      depthWrite: false,
      polygonOffset: !isCommentMarker,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      transparent: true,
      opacity: 0.95,
    });
    const outerRing = new THREE.Mesh(ringGeo, ringMat);
    outerRing.position.set(pt.x, pt.y + 0.03, pt.z);
    outerRing.userData.isZoomInvariantRing = true;
    outerRing.userData.pixelRadius = 8.5;
    if (studioThree.camera) {
      outerRing.quaternion.copy(studioThree.camera.quaternion);
    }
    outerRing.renderOrder = 1001;
    emit(outerRing);

    updateZoomInvariantElements();
    return innerMesh;
  }

  function add2DBadge(worldPt, htmlText, borderColor = "#cbd5e1", options = {}) {
    const container = document.getElementById("studioOverlay2D");
    if (!container) return null;
    const translatedHtml =
      typeof window.translateDynamicHtml === "function" ? window.translateDynamicHtml(String(htmlText || "")) : String(htmlText || "");
    const el = document.createElement("div");
    const clonedPt = worldPt.clone();
    if (options.rawHtml) {
      el.innerHTML = translatedHtml;
      const firstChild = el.firstElementChild;
      if (firstChild) {
        firstChild.style.position = "absolute";
        firstChild.style.pointerEvents = options.pointerEventsAuto ? "auto" : "none";
        if (options.isCategorize) firstChild.classList.add("is-categorize-badge");
        container.appendChild(firstChild);
        const badgeObj = {
          el: firstChild,
          worldPt: clonedPt,
          worldPos: clonedPt,
          offsetX: options.offsetX || 0,
          offsetY: options.offsetY || 0,
          isVolume: !!options.isVolume,
          isArea: !!options.isArea,
          isLassoHighlight: !!options.isLassoHighlight,
          isProfile: !!options.isProfile,
          isCategorize: !!options.isCategorize,
          isCommentPin: !!options.isCommentPin,
          folderKey: options.folderKey || "",
          isTempDistance: !!options.isTempDistance,
          priority: options.priority !== undefined ? Number(options.priority) : 50,
          featureId: options.featureId || "",
          isFocused: !!options.isFocused,
        };
        STATE.badges2D.push(badgeObj);
        update2DBadgePositions();
        if (!options.isTempDistance && !options.isCategorize && !options.isLassoHighlight && !options.isCommentPin) {
          SHARE_TELEMETRY.recordMeasurement(firstChild.textContent || "");
        }
        return badgeObj;
      }
    }
    el.className = options.isCategorize ? "measure-badge-2d is-categorize-badge" : "measure-badge-2d";
    el.style.position = "absolute";
    el.style.pointerEvents = "none";
    el.style.borderColor = borderColor;
    let finalHtml = translatedHtml;
    if (options.isCategorize && options.featureId && options.catKey && options.catKey !== "stockpiles") {
      finalHtml += ` <button type="button" data-cat-badge-del="${escapeHtml(options.featureId)}" data-cat-badge-type="${escapeHtml(options.catKey)}" title="${tr("刪除此分類項目", "Remove")} ${escapeHtml(options.featureId)}" style="margin-left:5px;padding:0 4px;border:none;border-radius:4px;background:rgba(239,68,68,0.24);color:#fca5a5;cursor:pointer;font-size:10px;line-height:1.2;pointer-events:auto;">×</button>`;
    }
    el.innerHTML = finalHtml;
    const delBtn = el.querySelector("[data-cat-badge-del]");
    if (delBtn) {
      delBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const fid = delBtn.getAttribute("data-cat-badge-del");
        const ctype = delBtn.getAttribute("data-cat-badge-type");
        const catMap = { water: "water_bodies", roads: "roads", walls: "walls", trees: "trees" };
        if (fid && ctype && typeof submitCategorizeManualEdit === "function") {
          submitCategorizeManualEdit("manual_remove", catMap[ctype] || ctype, fid);
        }
      });
    }
    container.appendChild(el);
    const badgeObj = {
      el,
      worldPt: clonedPt,
      worldPos: clonedPt,
      offsetX: options.offsetX || 0,
      offsetY: options.offsetY !== undefined ? options.offsetY : -10,
      isVolume: !!options.isVolume,
      isArea: !!options.isArea,
      isLassoHighlight: !!options.isLassoHighlight,
      isProfile: !!options.isProfile,
      isCategorize: !!options.isCategorize,
      folderKey: options.folderKey || "",
      isTempDistance: !!options.isTempDistance,
      priority: options.priority !== undefined ? Number(options.priority) : 50,
      featureId: options.featureId || "",
      catKey: options.catKey || "",
      isFocused: !!options.isFocused,
    };
    STATE.badges2D.push(badgeObj);
    update2DBadgePositions();
    if (!options.isTempDistance && !options.isCategorize && !options.isLassoHighlight) {
      SHARE_TELEMETRY.recordMeasurement(el.textContent || "");
    }
    return badgeObj;
  }

  function update2DBadgePositions() {
    if (!studioThree || !studioThree.camera || !studioThree.renderer) return;
    const w = studioThree.renderer.domElement.clientWidth;
    const h = studioThree.renderer.domElement.clientHeight;
    const isMobile = w <= 768;
    const panelEl = document.getElementById("studioSidePanel");
    const panelOpen = Boolean(panelEl && (panelEl.classList.contains("open") || panelEl.classList.contains("active")) && !panelEl.classList.contains("hidden"));
    const panelMinimized = Boolean(panelEl && panelEl.classList.contains("mobile-minimized"));
    const mobHudEl = document.getElementById("studioMobileToolHud");
    const mobHudOpen = Boolean(isMobile && mobHudEl && mobHudEl.style.display !== "none" && mobHudEl.offsetHeight > 0);
    const rightSafeX = isMobile ? w - 8 : w - (panelOpen ? (panelEl.offsetWidth || 380) + 16 : 14);
    const leftSafeX = isMobile ? 8 : 86;
    const topSafeY = isMobile ? (mobHudOpen ? 116 : 74) : 68;
    const bottomSafeY = isMobile
      ? h - (panelOpen && !panelMinimized ? Math.min(240, (panelEl.offsetHeight || 180) + 96) : 102)
      : h - 84;
    const placedRects = [];
    const candidateOffsets = [
      [0, 0],
      [0, -28],
      [0, 28],
      [-36, -20],
      [36, 20],
    ];

    const orderedBadges = STATE.badges2D.slice().sort((a, b) => {
      const aCat = Boolean(a.isCategorize || a.el?.classList?.contains("is-categorize-badge"));
      const bCat = Boolean(b.isCategorize || b.el?.classList?.contains("is-categorize-badge"));
      if (aCat !== bCat) return aCat ? 1 : -1;
      const aPri = a.isFocused ? 1000 : Number(a.priority ?? 50);
      const bPri = b.isFocused ? 1000 : Number(b.priority ?? 50);
      return bPri - aPri;
    });

    let visibleCatBadges = 0;
    orderedBadges.forEach((b) => {
      const anchorPt = b.worldPt || b.worldPos;
      if (!b.el || !anchorPt) return;
      const v = anchorPt.clone().project(studioThree.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.22 || Math.abs(v.y) > 1.22) {
        b.el.style.display = "none";
        return;
      }

      const x = (v.x * 0.5 + 0.5) * w + (b.offsetX || 0);
      const y = (-(v.y * 0.5) + 0.5) * h + (b.offsetY || 0);
      const dispMode = b.el.classList.contains("autodesk-delta-badge")
        ? "flex"
        : b.el.classList.contains("autodesk-flex-badge")
        ? "inline-flex"
        : "block";

      const isCat = Boolean(b.isCategorize || b.el.classList.contains("is-categorize-badge"));
      if (b.isCommentPin) {
        if (b.folderKey && STATE.hiddenCommentFolders && STATE.hiddenCommentFolders[b.folderKey]) {
          b.el.style.display = "none";
          return;
        }
        if (STATE.categorizeLabelsVisible === false) {
          b.el.style.display = "none";
          return;
        }
        b.el.style.display = "inline-flex";
        b.el.style.left = `${Math.round(x)}px`;
        b.el.style.top = `${Math.round(y)}px`;
        b.el.classList.toggle("flip-left", x > w - 245);
        b.el.classList.toggle("flip-down", y < 95);
        return;
      }
      if (!isCat) {
        if (STATE.categorizeLabelsVisible === false && !b.isTempDistance && !b.isLassoHighlight) {
          b.el.style.display = "none";
          return;
        }
        b.el.style.display = dispMode;
        const bw = b.el.offsetWidth || 160;
        const bh = b.el.offsetHeight || 36;
        const halfW = Math.min(bw * 0.5, Math.max(16, w * 0.5 - 8));
        const halfH = bh * 0.5;
        const minX = isMobile ? Math.max(24, halfW + 8) : halfW + 8;
        const maxX = isMobile ? Math.min(w - 24, w - halfW - 8) : w - halfW - 8;
        const clampedX = Math.max(minX, Math.min(Math.max(minX, maxX), x));
        const minY = isMobile ? Math.max(mobHudOpen ? 122 : 82, bh + (mobHudOpen ? 108 : 66)) : 58;
        const maxY = isMobile ? Math.max(minY + 12, bottomSafeY - 6) : h - 72;
        let clampedY = h > 160 ? Math.max(minY, Math.min(Math.max(minY, maxY), y)) : y;

        // Screen-space de-overlapping pass so pinned measurement badges (P1, P2, P3, Laser, Angle) never stack
        const nudgeStep = Math.max(26, bh + 6);
        const nudgeCandidates = [0, -nudgeStep, nudgeStep, -2 * nudgeStep, 2 * nudgeStep];
        for (const dy of nudgeCandidates) {
          const testY = h > 160 ? Math.max(minY, Math.min(Math.max(minY, maxY), clampedY + dy)) : clampedY + dy;
          const r0 = clampedX - halfW - 2;
          const r1 = testY - halfH - 2;
          const r2 = clampedX + halfW + 2;
          const r3 = testY + halfH + 2;
          const hasOverlap = placedRects.some((pr) => !(r2 < pr[0] || r0 > pr[2] || r3 < pr[1] || r1 > pr[3]));
          if (!hasOverlap) {
            clampedY = testY;
            break;
          }
        }

        b.el.style.left = `${clampedX}px`;
        b.el.style.top = `${clampedY}px`;
        placedRects.push([clampedX - halfW - 4, clampedY - halfH - 4, clampedX + halfW + 4, clampedY + halfH + 4]);
        return;
      }

      if (STATE.categorizeLabelsVisible === false) {
        b.el.style.display = "none";
        return;
      }

      if (visibleCatBadges >= 11 && !b.isFocused) {
        b.el.style.display = "none";
        return;
      }

      // Measure dimensions for categorize badge
      if (!b._cachedW || !b._cachedH) {
        b.el.style.display = dispMode;
        b._cachedW = b.el.offsetWidth || 152;
        b._cachedH = b.el.offsetHeight || 24;
      }
      const bw = b._cachedW;
      const bh = b._cachedH;
      const halfW = bw * 0.5;
      const halfH = bh * 0.5;

      // Hide categorize badge if its raw projected anchor falls far outside the safe viewport (or behind #studioSidePanel)
      if (
        x < leftSafeX + halfW - 24 ||
        x > rightSafeX - halfW + 16 ||
        y < topSafeY + halfH - 28 ||
        y > bottomSafeY - halfH + 24
      ) {
        b.el.style.display = "none";
        return;
      }
      const baseClampedX = Math.max(leftSafeX + halfW, Math.min(rightSafeX - halfW, x));
      const baseClampedY = Math.max(topSafeY + halfH, Math.min(bottomSafeY - halfH, y));

      // 2D Screen-Space AABB Collision Avoidance across candidate offsets
      let chosenPos = null;
      let chosenRect = null;
      for (let oi = 0; oi < candidateOffsets.length; oi++) {
        const cx = baseClampedX + candidateOffsets[oi][0];
        const cy = baseClampedY + candidateOffsets[oi][1];
        if (
          cx - halfW < leftSafeX ||
          cx + halfW > rightSafeX ||
          cy - halfH < topSafeY ||
          cy + halfH > bottomSafeY
        ) {
          continue;
        }
        const candRect = [cx - halfW - 6, cy - halfH - 5, cx + halfW + 6, cy + halfH + 5];
        let collides = false;
        for (let ri = 0; ri < placedRects.length; ri++) {
          const r = placedRects[ri];
          if (!(candRect[2] < r[0] || candRect[0] > r[2] || candRect[3] < r[1] || candRect[1] > r[3])) {
            collides = true;
            break;
          }
        }
        if (!collides) {
          chosenPos = [cx, cy];
          chosenRect = candRect;
          break;
        }
      }

      if (!chosenPos) {
        b.el.style.display = "none";
        return;
      }

      visibleCatBadges++;
      placedRects.push(chosenRect);
      b.el.style.display = dispMode;
      b.el.style.left = `${Math.round(chosenPos[0])}px`;
      b.el.style.top = `${Math.round(chosenPos[1])}px`;
    });
  }

  // Screen-space zoom-invariant scaling for Gathering Cloud distance & surveying tool markers & rods (Fix #5)
  function updateZoomInvariantElements() {
    if (!studioThree) return;
    const cam = studioThree.camera;
    const h = Math.max(1, studioThree.renderer.domElement.clientHeight);
    const fovRad = THREE.MathUtils.degToRad(cam.fov);

    const groups = [
      studioThree.overlayGroup,
      studioThree.volumeGroup,
      studioThree.polyPreviewGroup,
      studioThree.contourGroup,
      studioThree.categoryGroup,
      studioThree.commentPinsGroup,
    ].filter(Boolean);

    groups.forEach((grp) => {
      grp.traverse((obj) => {
        if (!obj.userData) return;
        if (obj.userData.isZoomInvariantMarker || obj.userData.isZoomInvariantRing) {
          obj.getWorldPosition(_tmpZoomWorldPos);
          const dist = Math.max(0.1, cam.position.distanceTo(_tmpZoomWorldPos));
          const worldPerPixel = (2 * Math.tan(fovRad / 2) * dist) / h;
          const r = (obj.userData.pixelRadius || 5.5) * worldPerPixel * 0.55;
          obj.scale.setScalar(Math.max(0.0025, r));
          if (obj.userData.isZoomInvariantRing) {
            obj.quaternion.copy(cam.quaternion);
          }
        } else if (obj.userData.isZoomInvariantRod) {
          obj.getWorldPosition(_tmpZoomWorldPos);
          const dist = Math.max(0.1, cam.position.distanceTo(_tmpZoomWorldPos));
          const worldPerPixel = (2 * Math.tan(fovRad / 2) * dist) / h;
          const rad = Math.max(0.002, (obj.userData.pixelRadius || 1.35) * worldPerPixel * 0.55);
          obj.scale.set(rad, 1, rad);
        }
      });
    });
  }

  function syncStudioControlsForTool() {
    if (!studioThree || !studioThree.controls) return;
    if (STATE.fpMode?.active) {
      studioThree.controls.enabled = false;
      if (studioThree.renderer && studioThree.renderer.domElement) {
        studioThree.renderer.domElement.style.cursor =
          document.pointerLockElement === studioThree.renderer.domElement ? "none" : "grab";
      }
      return;
    }
    const isFreehandLasso =
      (STATE.activeTool === "crop_delete" || STATE.activeTool === "crop") &&
      STATE.lassoInputMethod !== "polygon" &&
      !STATE.studioLassoOrbitMode;
    studioThree.controls.enabled = true;
    studioThree.controls.enableRotate = true;
    studioThree.controls.enableZoom = true;
    studioThree.controls.enablePan = true;
    studioThree.controls.screenSpacePanning = true;
    studioThree.controls.mouseButtons = {
      LEFT: isFreehandLasso ? -1 : THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
    studioThree.controls.touches = {
      ONE: isFreehandLasso ? -1 : THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    if (studioThree.renderer && studioThree.renderer.domElement) {
      studioThree.renderer.domElement.style.cursor =
        (STATE.activeTool === "crop" || STATE.activeTool === "crop_delete") && !STATE.studioLassoOrbitMode
          ? "crosshair"
          : "";
    }
  }

  // =========================================================================
  // VIDEO-GAME FIRST-PERSON CAMERA ENGINE (WASD + Fly / Surface Walk + PointerLock)
  // =========================================================================
  const FP_MOVEMENT_CODES = new Set([
    "KeyW",
    "KeyA",
    "KeyS",
    "KeyD",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Space",
    "KeyE",
    "KeyQ",
    "KeyC",
    "PageUp",
    "PageDown",
    "ShiftLeft",
    "ShiftRight",
    "AltLeft",
    "AltRight",
    "ControlLeft",
    "ControlRight",
  ]);

  function syncFirstPersonHudUI() {
    const fp = STATE.fpMode;
    const isActive = Boolean(fp.active && STATE.activeView === "studio");
    const domEl = studioThree?.renderer?.domElement || null;
    fp.pointerLocked = Boolean(domEl && document.pointerLockElement === domEl);

    document.getElementById("btnToggleFirstPerson")?.classList.toggle("active", isActive);
    document.getElementById("btnStudioFirstPerson")?.classList.toggle("active", isActive);
    document.getElementById("studioFirstPersonHud")?.classList.toggle("active", isActive);
    document.getElementById("studioFpCrosshair")?.classList.toggle("active", isActive);
    document.getElementById("fpTouchMovePad")?.classList.toggle("active", isActive);

    if (!isActive) return;

    document.getElementById("btnFpModeFly")?.classList.toggle("active", fp.locomotion === "fly");
    document.getElementById("btnFpModeWalk")?.classList.toggle("active", fp.locomotion === "walk");

    const lockBtn = document.getElementById("btnFpPointerLock");
    if (lockBtn) {
      lockBtn.classList.toggle("locked", fp.pointerLocked);
      lockBtn.textContent = fp.pointerLocked
        ? tr("🔒 準星已鎖定 (Esc 解鎖滑鼠)", "🔒 Crosshair Locked (Esc to Unlock)")
        : tr("🎯 點擊畫面鎖定滑鼠 (或拖曳旋轉)", "🎯 Click to Lock Mouse (or Drag to Look)");
    }

    const slider = document.getElementById("fpSpeedSlider");
    if (slider && document.activeElement !== slider) {
      slider.value = String(fp.baseSpeed);
    }

    const lblSpeed = document.getElementById("lblFpSpeed");
    if (lblSpeed) {
      const sprint = Boolean(fp.keys.ShiftLeft || fp.keys.ShiftRight);
      const slow = Boolean(fp.keys.AltLeft || fp.keys.AltRight);
      const isCrouch = Boolean(fp.keys.KeyC || fp.keys.ControlLeft || fp.keys.ControlRight);
      const mult = sprint ? 3.0 : slow ? 0.25 : 1.0;
      const eff =
        fp.locomotion === "walk"
          ? Math.min(9.0, Math.max(1.2, Math.min(12.0, fp.baseSpeed * 0.6)) * mult * (isCrouch ? 0.55 : 1.0))
          : fp.baseSpeed * mult;
      lblSpeed.textContent = `${eff.toFixed(1)} m/s${sprint ? " ⚡" : slow ? " 🐢" : ""}`;
    }

    const upKey = document.getElementById("lblFpUpKeyHint");
    const upAct = document.getElementById("lblFpUpActionHint");
    const dnKey = document.getElementById("lblFpDownKeyHint");
    const dnAct = document.getElementById("lblFpDownActionHint");
    if (fp.locomotion === "walk") {
      if (upKey) upKey.textContent = "Space";
      if (upAct) upAct.textContent = tr("跳躍", "Jump");
      if (dnKey) dnKey.textContent = "C";
      if (dnAct) dnAct.textContent = tr("蹲下", "Crouch");
    } else {
      if (upKey) upKey.textContent = "Space/E";
      if (upAct) upAct.textContent = tr("上升", "Up");
      if (dnKey) dnKey.textContent = "C/Q";
      if (dnAct) dnAct.textContent = tr("下降", "Down");
    }
  }

  function requestStudioPointerLock() {
    const domEl = studioThree?.renderer?.domElement;
    if (!domEl || !STATE.fpMode.active) return;
    if (document.pointerLockElement === domEl) return;
    try {
      const res = domEl.requestPointerLock();
      if (res && typeof res.catch === "function") {
        res.catch(() => {});
      }
    } catch (_) {}
  }

  function updateFirstPersonCrosshairPreview() {
    if (!STATE.fpMode.active || !studioThree?.renderer?.domElement) return;
    const tool = STATE.activeTool;
    if (!["laser", "coordinates", "angle", "distance", "area", "volume", "contours", "profile"].includes(tool)) return;
    const rect = studioThree.renderer.domElement.getBoundingClientRect();
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    if (tool === "laser") {
      handleStudioLaserMove({ clientX: cx, clientY: cy });
    } else if (tool === "coordinates") {
      handleStudioCoordinateMove({ clientX: cx, clientY: cy });
    } else if (tool === "angle") {
      handleStudioAngleMove({ clientX: cx, clientY: cy });
    } else if (tool === "distance") {
      const hoverPt = pickStudio3DPoint(cx, cy);
      if (hoverPt) {
        const twd = localToTwd97(hoverPt);
        const lbl = document.getElementById("lblLastPickedCoord");
        if (lbl) lbl.textContent = formatScanCoordReadout(twd, STATE.activeScan);
        if (STATE.measurePoints.length === 1) renderDistanceVisuals(hoverPt, null);
      }
    } else if (
      (tool === "area" || tool === "volume" || tool === "contours" || (tool === "profile" && STATE.measurePoints.length === 1)) &&
      STATE.measurePoints.length >= 1
    ) {
      const hoverPt = pickStudio3DPoint(cx, cy);
      if (hoverPt) {
        renderPolygonRubberband(hoverPt);
        if (tool === "profile" && STATE.measurePoints.length === 1) {
          const dAB = STATE.measurePoints[0].distanceTo(hoverPt);
          const lbl = document.getElementById("lblLastPickedCoord");
          if (lbl) {
            const twd = localToTwd97(hoverPt);
            lbl.textContent = `SECTION A→B: ${dAB.toFixed(2)}m | ${formatScanCoordReadout(twd, STATE.activeScan)}`;
          }
        }
      }
    }
  }

  function applyFirstPersonLookDelta(dx, dy, sensitivity = 0.0022) {
    if (!STATE.fpMode.active || !studioThree?.camera) return;
    const fp = STATE.fpMode;
    fp.yaw -= dx * sensitivity;
    const maxPitch = THREE.MathUtils.degToRad(88.5);
    fp.pitch = Math.max(-maxPitch, Math.min(maxPitch, fp.pitch - dy * sensitivity));
    studioThree.camera.rotation.order = "YXZ";
    studioThree.camera.rotation.set(fp.pitch, fp.yaw, 0);
    studioThree.camera.updateMatrixWorld(true);
    if (document.pointerLockElement === studioThree.renderer?.domElement) {
      updateFirstPersonCrosshairPreview();
    }
  }

  function setFirstPersonLocomotion(mode, showFeedback = true) {
    const fp = STATE.fpMode;
    const next = mode === "walk" ? "walk" : "fly";
    fp.locomotion = next;
    fp.velY = 0;

    if (next === "walk" && studioThree?.camera) {
      const cam = studioThree.camera;
      const idx = getLaserSpatialIndex(650);
      let landed = false;
      const resolveSafeEyeY = (gx, gy, gz) => {
        if (!idx) return gy + fp.eyeHeight;
        const ceilHit = castRayInLaserGrid(idx, gx, gy + 0.15, gz, 0, 1, 0, 0.05, fp.eyeHeight + 0.25, 1.01);
        if (ceilHit) {
          return Math.max(gy + 0.65, Math.min(gy + fp.eyeHeight, ceilHit.y - 0.22));
        }
        return gy + fp.eyeHeight;
      };
      if (idx) {
        const downHit = castRayInLaserGrid(idx, cam.position.x, cam.position.y + 1.5, cam.position.z, 0, -1, 0, 0.05, 80.0, 1.01);
        if (downHit && downHit.absNy >= 0.42) {
          cam.position.y = resolveSafeEyeY(cam.position.x, downHit.y, cam.position.z);
          landed = true;
        }
      }
      if (!landed && studioThree.renderer?.domElement) {
        // Camera is high/off-axis from scan: land onto the surface currently at viewport center!
        const rect = studioThree.renderer.domElement.getBoundingClientRect();
        const centerHit = pickStudio3DHit(rect.left + rect.width * 0.5, rect.top + rect.height * 0.5);
        if (centerHit && centerHit.rawPoint) {
          const gx = centerHit.rawPoint.x;
          const gy = centerHit.rawPoint.y;
          const gz = centerHit.rawPoint.z;
          cam.position.set(gx, resolveSafeEyeY(gx, gy, gz), gz);
          fp.pitch = Math.max(-0.35, Math.min(0.25, fp.pitch));
          cam.rotation.order = "YXZ";
          cam.rotation.set(fp.pitch, fp.yaw, 0);
          landed = true;
        }
      }
      fp.currentEyeOffset = fp.eyeHeight;
      fp.onGround = landed;
      cam.updateMatrixWorld(true);
    }

    syncFirstPersonHudUI();
    if (showFeedback) {
      showToast(
        next === "walk"
          ? tr(
              "🚶 步行模式（1.68m 人眼視角 · Space 跳躍 · C 蹲下 · G 切換飛行）",
              "🚶 Walk Mode (1.68m eye level · Space Jump · C Crouch · G Toggle Fly)"
            )
          : tr(
              "🚀 自由飛行模式（WASD 移動 · Space/E 上升 · C/Q 下降 · 滾輪調速）",
              "🚀 Free Fly Mode (WASD Move · Space/E Up · C/Q Down · Wheel Speed)"
            )
      );
    }
  }

  function enterFirstPersonMode(options = {}) {
    if (STATE.activeView !== "studio") {
      switchView("studio", STATE.activeScanId);
    }
    initStudio3D();
    if (!studioThree || !studioThree.camera) return;

    const fp = STATE.fpMode;
    fp.prevTool =
      STATE.activeTool && STATE.activeTool !== "crop" && STATE.activeTool !== "crop_delete"
        ? STATE.activeTool
        : null;

    if (STATE.activeTool === "crop" || STATE.activeTool === "crop_delete") {
      cancelLassoToolMode(false);
    } else if (STATE.measurePoints.length === 0) {
      setActiveStudioTool(STATE.multiAlign?.active ? "align_merge" : "orbit");
    }

    const cam = studioThree.camera;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    fwd.normalize();

    fp.pitch = Math.asin(Math.max(-0.992, Math.min(0.992, fwd.y)));
    const hLen = Math.hypot(fwd.x, fwd.z);
    if (hLen > 1e-4) {
      fp.yaw = Math.atan2(-fwd.x, -fwd.z);
    }
    fp.velX = 0;
    fp.velY = 0;
    fp.velZ = 0;
    fp.keys = Object.create(null);
    fp.dragLooking = false;
    fp.lastFrameTime = performance.now();
    fp.active = true;

    cam.up.set(0, 1, 0);
    cam.rotation.order = "YXZ";
    cam.rotation.set(fp.pitch, fp.yaw, 0);
    cam.updateMatrixWorld(true);

    if (options.locomotion) {
      setFirstPersonLocomotion(options.locomotion, false);
    }

    if (window.innerWidth <= 768) {
      const panelEl = document.getElementById("studioSidePanel");
      if (panelEl) {
        panelEl.classList.remove("active", "open", "mobile-minimized", "gs-panel-minimized");
        panelEl.classList.add("hidden");
      }
      const editDockEl = document.getElementById("studioEditingDock");
      if (editDockEl) editDockEl.style.display = "none";
      const mobileHudEl = document.getElementById("studioMobileToolHud");
      if (mobileHudEl) mobileHudEl.style.display = "none";
      document.getElementById("btnToggleFirstPerson")?.scrollIntoView?.({
        behavior: "smooth",
        inline: "center",
        block: "nearest",
      });
    }

    syncStudioControlsForTool();
    syncFirstPersonHudUI();
    SHARE_TELEMETRY.recordFirstPersonToggle(true, fp.locomotion || "fly");

    if (!options.silent) {
      if (window.innerWidth <= 768) {
        showToast(
          tr(
            "🎮 第一人稱漫遊開啟 — 左下方向鍵移動 · 單指拖曳旋轉視角 · 頂部切換飛行/步行",
            "🎮 First-Person Roam ON — D-pad to move · 1-finger drag to look · Top bar to switch Fly/Walk"
          )
        );
      } else {
        showToast(
          tr(
            "🎮 第一人稱漫遊開啟 — WASD 移動 · 滑鼠拖曳或點擊鎖定視角 · 滾輪調速 · G 切換步行/飛行",
            "🎮 First-Person Roam ON — WASD Move · Drag or Click to Lock Mouse · Wheel Speed · G Fly/Walk"
          )
        );
      }
    }
  }

  function exitFirstPersonMode(silent = false) {
    const fp = STATE.fpMode;
    if (!fp.active) return;
    fp.active = false;
    SHARE_TELEMETRY.recordFirstPersonToggle(false);
    fp.keys = Object.create(null);
    fp.dragLooking = false;
    fp.velX = 0;
    fp.velY = 0;
    fp.velZ = 0;

    if (document.pointerLockElement) {
      try {
        document.exitPointerLock();
      } catch (_) {}
    }

    if (studioThree && studioThree.camera && studioThree.controls) {
      const cam = studioThree.camera;
      const fx = -Math.sin(fp.yaw) * Math.cos(fp.pitch);
      const fy = Math.sin(fp.pitch);
      const fz = -Math.cos(fp.yaw) * Math.cos(fp.pitch);
      const fwd = new THREE.Vector3(fx, fy, fz).normalize();

      let focusDist = 14.0;
      const idx = studioThree._laserSpatialIndex;
      if (idx) {
        const hit = castRayInLaserGrid(idx, cam.position.x, cam.position.y, cam.position.z, fwd.x, fwd.y, fwd.z, 0.5, 65.0, 1.01);
        if (hit) focusDist = Math.max(2.5, Math.min(45.0, hit.t));
      } else if (studioThree.renderer?.domElement) {
        const rect = studioThree.renderer.domElement.getBoundingClientRect();
        const centerHit = pickStudio3DHit(rect.left + rect.width * 0.5, rect.top + rect.height * 0.5);
        if (centerHit && centerHit.rawPoint) {
          focusDist = Math.max(2.5, Math.min(45.0, cam.position.distanceTo(centerHit.rawPoint)));
        }
      }
      studioThree.controls.target.copy(cam.position).addScaledVector(fwd, focusDist);
      cam.up.set(0, 1, 0);
      cam.rotation.order = "XYZ";
      if (
        !silent &&
        STATE.activeTool === "orbit" &&
        fp.prevTool &&
        fp.prevTool !== "orbit" &&
        fp.prevTool !== "crop" &&
        fp.prevTool !== "crop_delete"
      ) {
        setActiveStudioTool(fp.prevTool);
      } else {
        syncStudioControlsForTool();
      }
      fp.prevTool = null;
      studioThree.controls.update();
      cam.updateMatrixWorld(true);
    }

    syncFirstPersonHudUI();
    applyRolePermissionsToUI();
    if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
    if (!silent) {
      showToast(tr("已離開第一人稱漫遊，返回環繞視角", "Exited First-Person Roam — returned to Orbit Mode"));
    }
  }

  function toggleFirstPersonMode() {
    if (STATE.fpMode.active) {
      exitFirstPersonMode(false);
    } else {
      enterFirstPersonMode();
    }
  }

  function updateFirstPersonCamera(nowMs) {
    const fp = STATE.fpMode;
    if (!fp.active || !studioThree?.camera) return;
    const cam = studioThree.camera;
    const dt = Math.min(0.06, Math.max(0.001, (nowMs - (fp.lastFrameTime || nowMs)) / 1000));
    fp.lastFrameTime = nowMs;

    const k = fp.keys;
    const moveFwd = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
    const moveRight = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
    const isSprint = Boolean(k.ShiftLeft || k.ShiftRight);
    const isSlow = Boolean(k.AltLeft || k.AltRight);
    const speedMult = isSprint ? 3.0 : isSlow ? 0.25 : 1.0;

    if (fp.locomotion === "walk") {
      // Pressing E / PageUp in Walk mode smoothly lifts off into Fly mode!
      if (k.KeyE || k.PageUp) {
        setFirstPersonLocomotion("fly", true);
      }
    }

    if (fp.locomotion === "fly") {
      const moveUp = (k.Space || k.KeyE || k.PageUp ? 1 : 0) - (k.KeyC || k.KeyQ || k.PageDown ? 1 : 0);
      const targetSpeed = fp.baseSpeed * speedMult;

      const fx = -Math.sin(fp.yaw) * Math.cos(fp.pitch);
      const fy = Math.sin(fp.pitch);
      const fz = -Math.cos(fp.yaw) * Math.cos(fp.pitch);
      const rx = Math.cos(fp.yaw);
      const rz = -Math.sin(fp.yaw);

      let dx = fx * moveFwd + rx * moveRight;
      let dy = fy * moveFwd + moveUp;
      let dz = fz * moveFwd + rz * moveRight;
      const dLen = Math.hypot(dx, dy, dz);
      if (dLen > 1.0) {
        dx /= dLen;
        dy /= dLen;
        dz /= dLen;
      }

      const alpha = 1 - Math.exp(-(dLen > 0.01 ? 14.0 : 11.5) * dt);
      fp.velX += (dx * targetSpeed - fp.velX) * alpha;
      fp.velY += (dy * targetSpeed - fp.velY) * alpha;
      fp.velZ += (dz * targetSpeed - fp.velZ) * alpha;

      cam.position.x += fp.velX * dt;
      cam.position.y += fp.velY * dt;
      cam.position.z += fp.velZ * dt;
    } else {
      // Walk Mode: Surface terrain following + 1.68m eye height + crouch + ceiling stand-up check + Space jump + multi-ray sub-stepped wall sliding
      const idx = getLaserSpatialIndex(650);
      const prevFeetY = cam.position.y - fp.currentEyeOffset;
      const isCrouchKey = Boolean(k.KeyC || k.ControlLeft || k.ControlRight);
      let targetEye = isCrouchKey ? 0.95 : fp.eyeHeight;
      if (!isCrouchKey && idx) {
        const standCeilHit = castRayInLaserGrid(idx, cam.position.x, prevFeetY + 0.88, cam.position.z, 0, 1, 0, 0.02, fp.eyeHeight - 0.66, 1.01);
        if (standCeilHit) {
          targetEye = Math.max(0.95, Math.min(targetEye, 0.88 + standCeilHit.t - 0.16));
        }
      }
      const isCrouch = targetEye < fp.eyeHeight - 0.25;
      fp.currentEyeOffset += (targetEye - fp.currentEyeOffset) * (1 - Math.exp(-12.0 * dt));

      const walkSpeed = Math.min(9.0, Math.max(1.2, Math.min(12.0, fp.baseSpeed * 0.6)) * speedMult * (isCrouch ? 0.55 : 1.0));
      const hx = -Math.sin(fp.yaw);
      const hz = -Math.cos(fp.yaw);
      const rx = Math.cos(fp.yaw);
      const rz = -Math.sin(fp.yaw);

      let dx = hx * moveFwd + rx * moveRight;
      let dz = hz * moveFwd + rz * moveRight;
      const hLen = Math.hypot(dx, dz);
      if (hLen > 1.0) {
        dx /= hLen;
        dz /= hLen;
      }

      const alpha = 1 - Math.exp(-(hLen > 0.01 ? 15.0 : 13.0) * dt);
      fp.velX += (dx * walkSpeed - fp.velX) * alpha;
      fp.velZ += (dz * walkSpeed - fp.velZ) * alpha;

      const totalStepX = fp.velX * dt;
      const totalStepZ = fp.velZ * dt;
      const totalStepDist = Math.hypot(totalStepX, totalStepZ);
      const feetY = cam.position.y - fp.currentEyeOffset;
      const bumperR = 0.38;

      if (idx && totalStepDist > 1e-4) {
        const headProbeH = Math.max(0.75, Math.min(1.52, fp.currentEyeOffset - 0.08));
        const probeBlocked = (ox, oz, ux, uz, dist) => {
          const chestHit = castRayInLaserGrid(idx, ox, feetY + 0.82, oz, ux, 0, uz, 0.03, dist + bumperR, 0.54);
          const headHit = castRayInLaserGrid(idx, ox, feetY + headProbeH, oz, ux, 0, uz, 0.03, dist + bumperR, 0.54);
          let minT = Infinity;
          if (chestHit && chestHit.t < minT) minT = chestHit.t;
          if (headHit && headHit.t < minT) minT = headHit.t;
          // Whisker feelers at +-28 deg to catch narrow corners & pillars
          const cosW = 0.88295, sinW = 0.46947;
          const wL = castRayInLaserGrid(idx, ox, feetY + 0.82, oz, ux * cosW - uz * sinW, 0, ux * sinW + uz * cosW, 0.03, dist + bumperR * 0.92, 0.54);
          const wR = castRayInLaserGrid(idx, ox, feetY + 0.82, oz, ux * cosW + uz * sinW, 0, -ux * sinW + uz * cosW, 0.03, dist + bumperR * 0.92, 0.54);
          if (wL && wL.t < minT) minT = wL.t;
          if (wR && wR.t < minT) minT = wR.t;
          return minT;
        };

        const nSub = Math.min(6, Math.max(1, Math.ceil(totalStepDist / 0.34)));
        const subDx = totalStepX / nSub;
        const subDz = totalStepZ / nSub;
        for (let si = 0; si < nSub; si++) {
          let sx = subDx;
          let sz = subDz;
          const sDist = Math.hypot(sx, sz);
          if (sDist <= 1e-5) break;
          const ux = sx / sDist;
          const uz = sz / sDist;
          const minHitT = probeBlocked(cam.position.x, cam.position.z, ux, uz, sDist);
          if (minHitT < sDist + bumperR) {
            const directAllowed = Math.max(0, minHitT - bumperR);
            const rem = sDist - directAllowed;
            cam.position.x += ux * directAllowed;
            cam.position.z += uz * directAllowed;
            // Smooth wall-tangent slide on remaining step
            if (rem > 1e-3) {
              const candXFirst = probeBlocked(cam.position.x, cam.position.z, Math.sign(sx) || 1, 0, Math.abs(sx));
              const candZFirst = probeBlocked(cam.position.x, cam.position.z, 0, Math.sign(sz) || 1, Math.abs(sz));
              if (Math.abs(sx) > 1e-4 && candXFirst >= Math.abs(sx) + bumperR) {
                cam.position.x += sx * (rem / sDist);
              } else if (Math.abs(sz) > 1e-4 && candZFirst >= Math.abs(sz) + bumperR) {
                cam.position.z += sz * (rem / sDist);
              } else {
                // Arbitrary-angle wall slide: try +-60 deg deflection feelers
                const cosS = 0.5, sinS = 0.866025;
                const d1x = ux * cosS - uz * sinS, d1z = ux * sinS + uz * cosS;
                const d2x = ux * cosS + uz * sinS, d2z = -ux * sinS + uz * cosS;
                const slideDist = rem * 0.55;
                const t1 = probeBlocked(cam.position.x, cam.position.z, d1x, d1z, slideDist);
                const t2 = probeBlocked(cam.position.x, cam.position.z, d2x, d2z, slideDist);
                if (t1 >= slideDist + bumperR && t1 >= t2) {
                  cam.position.x += d1x * slideDist;
                  cam.position.z += d1z * slideDist;
                } else if (t2 >= slideDist + bumperR) {
                  cam.position.x += d2x * slideDist;
                  cam.position.z += d2z * slideDist;
                }
              }
            }
          } else {
            cam.position.x += sx;
            cam.position.z += sz;
          }
        }
      } else {
        cam.position.x += totalStepX;
        cam.position.z += totalStepZ;
      }

      // Clamp downward ground probe start below any low ceiling/overhang so player never snaps up onto a roof
      let rayStartOffset = 1.25;
      if (idx) {
        const lowCeil = castRayInLaserGrid(idx, cam.position.x, feetY + 0.35, cam.position.z, 0, 1, 0, 0.04, 1.05, 1.01);
        if (lowCeil) {
          rayStartOffset = Math.max(0.38, Math.min(1.25, 0.35 + lowCeil.t - 0.08));
        }
      }
      const groundHit = idx
        ? castRayInLaserGrid(idx, cam.position.x, feetY + rayStartOffset, cam.position.z, 0, -1, 0, 0.04, 55.0, 1.01)
        : null;
      const minFloorY = Number.isFinite(studioThree?.grid?.position?.y) ? studioThree.grid.position.y : -10.0;

      if (fp.onGround) {
        if (k.Space) {
          fp.velY = 4.65;
          fp.onGround = false;
          cam.position.y += fp.velY * dt;
        } else if (groundHit && groundHit.absNy >= 0.38) {
          const dropDist = feetY - groundHit.y;
          if (dropDist <= 0.90) {
            const desiredY = groundHit.y + fp.currentEyeOffset;
            cam.position.y += (desiredY - cam.position.y) * (1 - Math.exp(-18.0 * dt));
            fp.velY = 0;
          } else {
            // Stepped off a high ledge onto lower scan terrain -> fall smoothly under gravity
            fp.onGround = false;
          }
        } else if (feetY > minFloorY + 0.25) {
          // Stepped off elevated mesh edge -> fall naturally under gravity down to ground reference grid
          fp.onGround = false;
        } else {
          fp.velY = 0;
        }
      }

      if (!fp.onGround) {
        fp.velY = Math.max(-32.0, fp.velY - 9.81 * dt);
        if (fp.velY > 0 && idx) {
          const ceilBump = castRayInLaserGrid(idx, cam.position.x, cam.position.y, cam.position.z, 0, 1, 0, 0.05, fp.velY * dt + 0.22, 1.01);
          if (ceilBump) fp.velY = 0;
        }
        const nextFeetY = feetY + fp.velY * dt;
        if (groundHit && groundHit.absNy >= 0.38 && nextFeetY <= groundHit.y && feetY >= groundHit.y - 1.35) {
          cam.position.y = groundHit.y + fp.currentEyeOffset;
          fp.velY = 0;
          fp.onGround = true;
        } else if (nextFeetY <= minFloorY && fp.velY < 0) {
          // Ground-level safety floor (never hovers mid-air when jumping off roofs, never falls to -Infinity)
          cam.position.y = minFloorY + fp.currentEyeOffset;
          fp.velY = 0;
          fp.onGround = true;
        } else {
          cam.position.y = nextFeetY + fp.currentEyeOffset;
        }
      }
    }

    cam.rotation.order = "YXZ";
    cam.rotation.set(fp.pitch, fp.yaw, 0);

    const linSpeed = Math.hypot(fp.velX, fp.velY, fp.velZ);
    if (linSpeed > 0.03) {
      const twd = localToTwd97(cam.position);
      const lbl = document.getElementById("lblLastPickedCoord");
      if (lbl && (!STATE.activeTool || STATE.activeTool === "orbit" || STATE.activeTool === "align_merge")) {
        lbl.textContent = `1ST PERSON -> ${formatScanCoordReadout(twd, STATE.activeScan)}`;
      }
      if (document.pointerLockElement === studioThree.renderer?.domElement) {
        updateFirstPersonCrosshairPreview();
      }
    }
  }

  function preserveLassoSelectionBeforeToolSwitch() {
    if (studioThree && typeof studioThree._cancelLassoDrag === "function") {
      studioThree._cancelLassoDrag();
    }
    if (
      (STATE.activeTool === "crop_delete" || STATE.activeTool === "crop") &&
      Array.isArray(STATE.measurePoints) &&
      STATE.measurePoints.length >= 3
    ) {
      const lockedPts = STATE.measurePoints.map((p) => p.clone());
      if (!Array.isArray(STATE.pendingCropPolygons)) STATE.pendingCropPolygons = [];
      STATE.pendingCropPolygons.push(lockedPts);
      STATE.polygonLocked = true;
    }
    STATE.measurePoints = [];
    STATE.cropPolygonPoints = [];
    if (studioThree && studioThree.polyPreviewGroup) {
      while (studioThree.polyPreviewGroup.children.length > 0) {
        const c = studioThree.polyPreviewGroup.children[0];
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
        studioThree.polyPreviewGroup.remove(c);
      }
    }
    if (
      (Array.isArray(STATE.lassoStrokes) && STATE.lassoStrokes.length > 0) ||
      (Array.isArray(STATE.pendingCropPolygons) && STATE.pendingCropPolygons.length > 0)
    ) {
      rebuildLassoHighlight3D();
    }
  }

  function cancelLassoToolMode(keepPanelOpen = true, clearSelection = false) {
    const wasKeep = (STATE.activeTool === "crop" || STATE.cropMode === "keep_inside") && !STATE.multiAlign?.active;
    if (clearSelection) {
      STATE.measurePoints = [];
      STATE.polygonLocked = false;
      clearLassoSelectionState();
    } else {
      preserveLassoSelectionBeforeToolSwitch();
    }
    STATE.cropMode = wasKeep ? "keep_inside" : "delete_inside";
    setActiveStudioTool("orbit");
    const panel = document.getElementById("studioSidePanel");
    if (keepPanelOpen && panel && panel.classList.contains("active")) {
      if (wasKeep) {
        openLassoKeepInspector({ armLasso: false });
      } else {
        openLassoDeleteInspector({ armLasso: false });
      }
    }
  }

  const MULTI_ALIGN_DISABLED_TOOLS = new Set([
    "volume",
    "contours",
    "profile",
    "photos",
    "rtk",
    "categorize",
    "drainage",
    "gcp_qa",
    "bookmarks",
    "comments",
    "crop",
  ]);

  const MULTI_ALIGN_DISABLED_ELEMENT_IDS = [
    "btnDockVolume",
    "btnDockContours",
    "btnMeasureProfile",
    "btnMeasurePhotos",
    "btnDockCategorize",
    "btnDockDrainage",
    "btnDockGcpQa",
    "btnDockBookmarks",
    "btnStudioSavedViews",
    "btnDockComments",
    "btnDockLassoKeep",
    "btnStudioSurveyReport",
    "studioProjectSelect",
    "studioScanSelect",
    "btnRenameStudioSite",
    "btnRenameStudioScan",
    "btnRerunStudioScan",
    "btnDeleteStudioScan",
    "btnStudioQuickShare",
    "btnStudioDownloadObj",
  ];

  function getMultiAlignDisabledReason() {
    return tr(
      "多掃描合併編輯中暫停使用 — 請先合併掃描或退出多掃描模式",
      "Unavailable during Multi-Scan Editing — merge scans first or exit Multi-Scan mode"
    );
  }

  function syncMultiAlignToolAvailability() {
    const isMulti = Boolean(STATE.multiAlign?.active);
    const lockSingleScan = Boolean(STATE.shareToken && STATE.shareInfo?.scope_type === "scan");
    const disabledReason = getMultiAlignDisabledReason();

    MULTI_ALIGN_DISABLED_ELEMENT_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (isMulti) {
        if (el.dataset.origTitle === undefined) {
          el.dataset.origTitle = el.getAttribute("title") || "";
        }
        el.setAttribute("title", disabledReason);
        el.classList.add("multi-align-disabled");
        el.classList.remove("active");
        el.setAttribute("aria-disabled", "true");
        if (el.tagName === "A") {
          const curHref = el.getAttribute("href");
          if (curHref) {
            el.dataset.origHref = curHref;
            el.removeAttribute("href");
          }
        } else {
          el.disabled = true;
        }
      } else {
        el.classList.remove("multi-align-disabled");
        el.removeAttribute("aria-disabled");
        if (el.dataset.origTitle !== undefined) {
          el.setAttribute("title", el.dataset.origTitle);
          delete el.dataset.origTitle;
        }
        if (el.tagName === "A") {
          if (el.dataset.origHref && !el.getAttribute("href")) {
            el.setAttribute("href", el.dataset.origHref);
          }
          delete el.dataset.origHref;
        } else if (id === "studioScanSelect" && lockSingleScan) {
          el.disabled = true;
        } else {
          el.disabled = false;
        }
      }
    });

    const alignBtn = document.getElementById("btnDockAlignMerge");
    if (alignBtn) {
      alignBtn.classList.toggle("multi-align-session", Boolean(isMulti && STATE.activeTool !== "align_merge"));
    }
  }

  function applyPreviewLodMode(mode, silent = false) {
    const validMode = mode === "rough" || mode === "auto" || mode === "max" ? mode : "rough";
    STATE.previewLodMode = validMode;
    try {
      localStorage.setItem("gs_preview_lod_mode_v2", validMode);
    } catch (_e) {}

    document.querySelectorAll("#previewLodModeSwitcher [data-lod-mode]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.lodMode === validMode);
    });
    const selPreview = document.getElementById("selPreviewLodMode");
    if (selPreview && selPreview.value !== validMode) selPreview.value = validMode;

    const isIOS = typeof isIOSOrIPadDevice === "function" && isIOSOrIPadDevice();
    const isMobOrTab = isIOS || (typeof isMobileOrTabletDevice === "function" && isMobileOrTabletDevice());
    const isLocalHost = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
    const previewTargetErr = validMode === "rough" ? 1e9 : validMode === "max" ? 1.2 : isMobOrTab ? 18.0 : 12.0;

    if (typeof previewThree !== "undefined" && previewThree) {
      if (
        validMode !== "rough" &&
        String(previewThree._loadedTilesetUrl || "").includes("preview_tileset.json") &&
        STATE.activeView === "map" &&
        STATE.activeScanId &&
        typeof loadScanIntoPreview === "function"
      ) {
        loadScanIntoPreview(STATE.activeScanId, true);
      } else if (previewThree.tilesRenderer) {
        previewThree.tilesRenderer.errorTarget = previewTargetErr;
        if (previewThree.tilesRenderer.downloadQueue) {
          previewThree.tilesRenderer.downloadQueue.maxJobs = isIOS ? 3 : isMobOrTab ? 4 : isLocalHost ? 8 : 4;
        }
        previewThree.camera?.updateMatrixWorld();
        previewThree.tilesRenderer.update();
        if (previewThree.renderer && previewThree.scene && previewThree.camera) {
          previewThree.renderer.render(previewThree.scene, previewThree.camera);
        }
      }
    }

    if (!silent && typeof showToast === "function") {
      const labelZh = validMode === "rough" ? "粗模 (極速預覽)" : validMode === "max" ? "精細 (高清)" : "自動 (漸進細化)";
      const labelEn = validMode === "rough" ? "Rough (Fast Preview)" : validMode === "max" ? "Max Detail" : "Auto Progressive";
      showToast(tr(`預覽畫質已切換至：${labelZh}`, `Preview Quality set to: ${labelEn}`));
    }
  }
  window.applyPreviewLodMode = applyPreviewLodMode;

  function applyScanLodMode(mode, silent = false) {
    const validMode = mode === "rough" || mode === "auto" || mode === "max" ? mode : "auto";
    STATE.scanLodMode = validMode;
    try {
      localStorage.setItem("gs_studio_lod_mode_v2", validMode);
    } catch (_e) {}

    document.querySelectorAll("#studioLodModeSwitcher [data-lod-mode], #settingsLodModeSwitcher [data-lod-mode]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.lodMode === validMode);
    });
    const selStudio = document.getElementById("selStudioLodMode");
    if (selStudio && selStudio.value !== validMode) selStudio.value = validMode;

    const isIOS = typeof isIOSOrIPadDevice === "function" && isIOSOrIPadDevice();
    const isMobOrTab = isIOS || (typeof isMobileOrTabletDevice === "function" && isMobileOrTabletDevice());
    const isLocalHost = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
    const targetErr = validMode === "rough" ? 1e9 : validMode === "max" ? 0.8 : isMobOrTab ? 10.0 : 2.0;

    if (studioThree) {
      if (
        validMode !== "rough" &&
        studioThree._loadedLowMemTileset &&
        STATE.activeView === "studio" &&
        STATE.activeScanId
      ) {
        loadScanIntoStudio(STATE.activeScanId, {
          preserveCamera: true,
          preserveTools: true,
          forceFullRes: true,
        });
      } else if (studioThree.tilesRenderer) {
        studioThree.tilesRenderer.errorTarget = targetErr;
        if (studioThree.tilesRenderer.downloadQueue) {
          studioThree.tilesRenderer.downloadQueue.maxJobs = isIOS ? 3 : isMobOrTab ? 4 : isLocalHost ? 16 : (validMode === "max" ? 6 : 4);
        }
        studioThree.camera?.updateMatrixWorld();
        studioThree.tilesRenderer.update();
        if (studioThree.renderer && studioThree.scene && studioThree.camera) {
          studioThree.renderer.render(studioThree.scene, studioThree.camera);
        }
      }
    }

    if (!silent && typeof showToast === "function") {
      const labelZh = validMode === "rough" ? "粗模 (L0 極速)" : validMode === "max" ? "精細 (最高解析度)" : "自動 (漸進細化)";
      const labelEn = validMode === "rough" ? "Rough (Fast)" : validMode === "max" ? "Max Detail" : "Auto Progressive";
      showToast(tr(`3D 工作坊畫質已切換至：${labelZh}`, `Studio 3D Quality set to: ${labelEn}`));
    }
  }
  window.applyScanLodMode = applyScanLodMode;

  if (typeof document !== "undefined" && !window.__gsLodSwitcherBound) {
    window.__gsLodSwitcherBound = true;
    document.addEventListener("click", (ev) => {
      const previewBtn = ev.target && typeof ev.target.closest === "function"
        ? ev.target.closest("#previewLodModeSwitcher [data-lod-mode]")
        : null;
      if (previewBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const mode = previewBtn.getAttribute("data-lod-mode");
        if (mode) applyPreviewLodMode(mode, false);
        return;
      }
      const btn = ev.target && typeof ev.target.closest === "function"
        ? ev.target.closest("#studioLodModeSwitcher [data-lod-mode], #settingsLodModeSwitcher [data-lod-mode]")
        : null;
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const mode = btn.getAttribute("data-lod-mode");
      if (mode) applyScanLodMode(mode, false);
    });
  }

  function setActiveStudioTool(toolName) {
    if (!toolName) return;
    if (STATE.multiAlign?.active && MULTI_ALIGN_DISABLED_TOOLS.has(toolName)) {
      showToast("Unavailable during Multi-Scan Editing — merge scans first (or exit Multi-Scan mode)");
      return;
    }
    if ((toolName === "crop" || toolName === "crop_delete" || toolName === "lasso") && STATE.scanLodMode !== "max") {
      applyScanLodMode("max", true);
      if (typeof showToast === "function") {
        showToast(tr("已自動鎖定「精細 (L2)」畫質以確保套索裁切跨圖層精準同步", "Locked to Max Detail (L2) for multi-LOD accurate Lasso editing"));
      }
    }
    if (STATE.activeTool === "section" && toolName !== "section") {
      clearSectionBoxClippingIfNotKept();
    }
    if (
      (STATE.activeTool === "crop" || STATE.activeTool === "crop_delete") &&
      toolName !== "crop" &&
      toolName !== "crop_delete" &&
      studioThree &&
      typeof studioThree._cancelLassoDrag === "function"
    ) {
      studioThree._cancelLassoDrag();
    }
    if ((toolName === "crop" || toolName === "crop_delete") && STATE.fpMode?.active) {
      exitFirstPersonMode(true);
    }
    if (toolName !== "crop" && toolName !== "crop_delete") {
      STATE.studioLassoOrbitMode = false;
      if (STATE.lassoEdit) STATE.lassoEdit.active = false;
      STATE.studioLassoMode = null;
    }
    if (toolName !== "categorize") {
      STATE.categorizeEditMode = null;
      STATE.categorizeEditPoints = [];
      STATE.categorizeTempPoints = [];
      STATE.categorizeOverlayVisible = false;
      if (typeof clearCategorizeVisualsOnly === "function") {
        clearCategorizeVisualsOnly();
      }
      if (typeof syncCategorizeVisibilityUI === "function") {
        syncCategorizeVisibilityUI();
      }
    }
    if (toolName !== "profile" && typeof clearProfileVisualsOnly === "function") {
      clearProfileVisualsOnly();
    }
    if (STATE.activeTool === "photos" && toolName !== "photos" && typeof clearPhotoTargetVisuals3D === "function") {
      clearPhotoTargetVisuals3D(true);
    }
    if (toolName !== "photos" && toolName !== "rtk") {
      if (typeof clearPhotoTargetVisuals3D === "function") {
        clearPhotoTargetVisuals3D(true);
      }
      if (studioThree?.cameraTrajectoryGroup) studioThree.cameraTrajectoryGroup.visible = false;
      if (studioThree?.photoFrustumGroup) studioThree.photoFrustumGroup.visible = false;
      if (studioThree?.photoTargetGroup) studioThree.photoTargetGroup.visible = false;
    }
    if (STATE.activeTool !== toolName) {
      STATE.measurePoints = [];
    }
    STATE.activeTool = toolName;
    SHARE_TELEMETRY.recordToolSelected(toolName);
    const sidePanelEl = document.getElementById("studioSidePanel");
    if (sidePanelEl) {
      sidePanelEl.setAttribute("data-active-tool", toolName || "");
      if (["distance", "angle", "area", "coordinates", "laser", "clear", "orbit"].includes(toolName)) {
        sidePanelEl.classList.remove("active", "open", "mobile-minimized", "gs-panel-minimized");
        sidePanelEl.classList.add("hidden");
      }
    }
    if (studioThree && studioThree.gizmoGroup) {
      studioThree.gizmoGroup.visible = Boolean(
        STATE.multiAlign?.active && toolName === "align_merge" && STATE.multiAlign?.selectedScanId
      );
    }
    clearTempDistanceVisuals();
    if (studioThree && studioThree.polyPreviewGroup) {
      while (studioThree.polyPreviewGroup.children.length > 0) {
        studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
      }
    }
    document
      .querySelectorAll(
        '#bimBottomDock .bim-dock-btn:not([data-tool="snap"]):not([data-tool="first_person"]):not(#btnToggleFirstPerson):not(#btnClearMeasurements):not(#btnMeasureClear), #studioEditingDock .bim-dock-btn'
      )
      .forEach((b) => {
        const key = b.dataset.tool || b.dataset.dock || "";
        const isActive = key === toolName;
        b.classList.toggle("active", isActive);
      });
    const bottomDock = document.getElementById("bimBottomDock");
    if (bottomDock && (toolName === "orbit" || window.innerWidth >= 560)) {
      bottomDock.scrollLeft = 0;
    }
    const lassoSvg = document.getElementById("studioLassoSvg");
    if (lassoSvg && toolName !== "crop" && toolName !== "crop_delete") {
      lassoSvg.classList.remove("active", "keep-mode", "sub-mode");
    }
    syncMultiAlignToolAvailability();
    syncStudioControlsForTool();
    if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
    update2DBadgePositions();
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

  function clearAreaVisualsOnly() {
    if (studioThree && studioThree.overlayGroup) {
      const toRemove = [];
      studioThree.overlayGroup.children.forEach((c) => {
        if (c.userData && c.userData.isAreaVisual) toRemove.push(c);
      });
      toRemove.forEach((c) => {
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
    STATE.badges2D = STATE.badges2D.filter((b) => {
      if (b.isArea) {
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
    STATE._volumeCalcSeq = (STATE._volumeCalcSeq || 0) + 1;
    if (typeof hideVolumeProgressHudPill === "function") {
      hideVolumeProgressHudPill();
    }
    STATE.movingVertex = null;
    STATE.measurePoints = [];
    STATE.completedMeasurements = [];
    STATE.cutFillPolygonPoints = [];
    STATE.maskBoundaryPoints = [];
    STATE.polygonLocked = false;
    if (studioThree) {
      studioThree._snapIndicatorRing = null;
      studioThree._movingVertexRing = null;
    }
    if (typeof clearLassoSelectionState === "function") {
      clearLassoSelectionState();
    }
    clearTempDistanceVisuals();
    clearAreaVisualsOnly();
    clearVolumeVisualsOnly();
    if (typeof clearProfileVisualsOnly === "function") {
      clearProfileVisualsOnly();
    }
    STATE.categorizeOverlayVisible = false;
    if (typeof clearCategorizeVisualsOnly === "function") {
      clearCategorizeVisualsOnly();
    }
    if (typeof syncCategorizeVisibilityUI === "function") {
      syncCategorizeVisibilityUI();
    }
    if (typeof clearDrainageVisuals3D === "function") {
      clearDrainageVisuals3D();
    }
    if (typeof clearGcpQaMarkers3D === "function") {
      clearGcpQaMarkers3D();
    }
    if (typeof clearRtkPhotoFrustums3D === "function") {
      clearRtkPhotoFrustums3D();
    }
    if (typeof clearPhotoTargetVisuals3D === "function") {
      clearPhotoTargetVisuals3D();
    }
    if (studioThree) {
      while (studioThree.overlayGroup.children.length > 0) {
        studioThree.overlayGroup.remove(studioThree.overlayGroup.children[0]);
      }
    }
    STATE.badges2D = STATE.badges2D.filter((b) => {
      if (b.isCommentPin) return true;
      b.el?.remove();
      return false;
    });
    if (typeof renderCommentPins3D === "function") {
      renderCommentPins3D();
    }
  }

  function rebuildAllCompletedMeasurements3D() {
    if (!studioThree || !studioThree.overlayGroup) return;
    clearTempDistanceVisuals();
    const toRemove = [];
    studioThree.overlayGroup.children.forEach((c) => {
      if (!c) return;
      if (
        c.userData?.isLassoHighlight ||
        c.userData?.isSnapIndicator ||
        c.userData?.isMovingVertexIndicator ||
        c.userData?.isPhotoTargetPin ||
        c.userData?.isSectionTempPin ||
        c === studioThree._sectionBoxHelper ||
        c === studioThree.sectionBoxGizmoGroup ||
        c === studioThree.drainageGroup ||
        c === studioThree.gcpQaGroup ||
        c === studioThree.photoFrustumGroup
      ) {
        return;
      }
      toRemove.push(c);
    });
    toRemove.forEach((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
      studioThree.overlayGroup.remove(c);
    });

    STATE.badges2D = STATE.badges2D.filter((b) => {
      if (b.isCommentPin || b.isCategorize || b.isVolume || b.isLassoHighlight || b.isProfile) {
        return true;
      }
      b.el?.remove();
      return false;
    });

    (STATE.completedMeasurements || []).forEach((m) => {
      if (!m || typeof m !== "object") return;
      if (m.type === "distance" && m.p1 && m.p2) {
        m.dist = m.p1.distanceTo(m.p2);
        renderDistanceVisuals(null, m);
      } else if (m.type === "angle" && m.p1 && m.p2 && m.p3) {
        renderAngleVisuals(null, m);
      } else if (m.type === "coordinates" && m.pt) {
        m.twd = localToTwd97(m.pt);
        renderCoordinateVisuals(m.pt, m);
      } else if (m.type === "area" && Array.isArray(m.points) && m.points.length >= 3) {
        if (typeof renderClosedAreaPolygon === "function") {
          renderClosedAreaPolygon(m.points, { preserveExistingAreas: true });
        }
      } else if (m.type === "laser") {
        if (typeof renderLaserVisuals === "function") {
          renderLaserVisuals(null, m);
        }
      }
    });

    const pts = Array.isArray(STATE.measurePoints) ? STATE.measurePoints : [];
    if (pts.length > 0) {
      if (STATE.activeTool === "distance") {
        renderDistanceVisuals(null, null);
      } else if (STATE.activeTool === "angle") {
        renderAngleVisuals(null, null);
      } else if (STATE.activeTool === "area") {
        const addAreaObj = (m) => {
          m.userData.isAreaVisual = true;
          studioThree.overlayGroup.add(m);
        };
        pts.forEach((p, idx) => {
          add3DPinMarker(p, idx === 0 ? 0xff3b30 : 0x0284c7, studioThree.overlayGroup, addAreaObj);
        });
        if (pts.length >= 2) {
          const lineGeom = new THREE.BufferGeometry().setFromPoints(pts);
          const lineMesh = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: 0x0284c7, depthTest: true }));
          addAreaObj(lineMesh);
        }
      } else if (STATE.activeTool === "volume" && typeof drawPlacedCutFillPolygon3D === "function") {
        drawPlacedCutFillPolygon3D(pts.slice(), null);
      } else if (STATE.activeTool === "contours") {
        pts.forEach((p, idx) => {
          add3DPinMarker(p, idx === 0 ? 0xff3b30 : 0x0284c7);
        });
      }
    }

    if (
      STATE.movingVertex?.source === "cutFillPolygonPoints" &&
      Array.isArray(STATE.cutFillPolygonPoints) &&
      STATE.cutFillPolygonPoints.length >= 2 &&
      typeof drawPlacedCutFillPolygon3D === "function"
    ) {
      drawPlacedCutFillPolygon3D(STATE.cutFillPolygonPoints, null);
    }

    if (
      Array.isArray(STATE.profileEndpoints) &&
      STATE.profileEndpoints.length >= 2 &&
      typeof drawProfileSectionLine3D === "function"
    ) {
      drawProfileSectionLine3D(
        STATE.profileEndpoints[0],
        STATE.profileEndpoints[1],
        STATE.movingVertex?.source === "profileEndpoints" ? null : STATE.lastProfileResult?.samples || null
      );
    }

    if (STATE.movingVertex && STATE.movingVertex.point) {
      updateStudioMovingVertexIndicator(STATE.movingVertex.point);
    }
    updateZoomInvariantElements();
    update2DBadgePositions();
  }
  window.rebuildAllCompletedMeasurements3D = rebuildAllCompletedMeasurements3D;

  function startStudioVertexMove(vDesc, opts = {}) {
    if (!vDesc || !vDesc.point) return false;
    if (STATE.movingVertex) {
      cancelStudioVertexMove(false);
    }
    const isDragMode = Boolean(opts && opts.dragMode);
    STATE.movingVertex = {
      point: vDesc.point,
      source: vDesc.source || "completed",
      measId: vDesc.measId || "",
      measType: vDesc.measType || "distance",
      pointKey: vDesc.pointKey || null,
      pointIndex: Number.isFinite(vDesc.pointIndex) ? vDesc.pointIndex : null,
      label: vDesc.label || "Point",
      originalPoint: vDesc.point.clone(),
      startedAt: performance.now(),
      dragMode: isDragMode,
      pointerId: opts?.pointerId !== undefined ? opts.pointerId : null,
      startClientX: Number.isFinite(opts?.startClientX) ? opts.startClientX : null,
      startClientY: Number.isFinite(opts?.startClientY) ? opts.startClientY : null,
      hasMoved: false,
    };
    updateStudioMovingVertexIndicator(vDesc.point);
    if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
    if (!isDragMode) {
      showToast(
        tr(
          `🎯 移動點位 (${STATE.movingVertex.label}) — 移動滑鼠預覽，點擊新位置放置，按 ESC 取消`,
          `🎯 Moving ${STATE.movingVertex.label} — Move cursor to preview, click to place, press ESC to cancel`
        )
      );
    }
    return true;
  }
  window.startStudioVertexMove = startStudioVertexMove;

  function updateStudioVertexMove(newPt) {
    if (!STATE.movingVertex || !STATE.movingVertex.point || !newPt) return false;
    STATE.movingVertex.point.copy(newPt);
    if (
      STATE.movingVertex.source === "cutFillPolygonPoints" &&
      Number.isFinite(STATE.movingVertex.pointIndex) &&
      Array.isArray(STATE.maskBoundaryPoints) &&
      STATE.maskBoundaryPoints[STATE.movingVertex.pointIndex]
    ) {
      STATE.maskBoundaryPoints[STATE.movingVertex.pointIndex].copy(newPt);
    }
    rebuildAllCompletedMeasurements3D();
    return true;
  }
  window.updateStudioVertexMove = updateStudioVertexMove;

  function commitStudioVertexMove(finalPt = null) {
    if (!STATE.movingVertex || !STATE.movingVertex.point) return false;
    if (finalPt) {
      STATE.movingVertex.point.copy(finalPt);
      if (
        STATE.movingVertex.source === "cutFillPolygonPoints" &&
        Number.isFinite(STATE.movingVertex.pointIndex) &&
        Array.isArray(STATE.maskBoundaryPoints) &&
        STATE.maskBoundaryPoints[STATE.movingVertex.pointIndex]
      ) {
        STATE.maskBoundaryPoints[STATE.movingVertex.pointIndex].copy(finalPt);
      }
    }
    const moved = STATE.movingVertex;
    STATE.movingVertex = null;
    updateStudioMovingVertexIndicator(null);
    syncStudioControlsForTool();
    rebuildAllCompletedMeasurements3D();
    if (
      moved.source === "cutFillPolygonPoints" &&
      Array.isArray(STATE.cutFillPolygonPoints) &&
      STATE.cutFillPolygonPoints.length >= 3 &&
      typeof openCutFillVolumeInspector === "function"
    ) {
      openCutFillVolumeInspector(STATE.cutFillPolygonPoints);
    } else if (
      moved.source === "profileEndpoints" &&
      Array.isArray(STATE.profileEndpoints) &&
      STATE.profileEndpoints.length >= 2 &&
      typeof openProfileInspector === "function"
    ) {
      if (typeof drawProfileSectionLine3D === "function") {
        drawProfileSectionLine3D(STATE.profileEndpoints[0], STATE.profileEndpoints[1]);
      }
      openProfileInspector(STATE.profileEndpoints[0], STATE.profileEndpoints[1]);
    } else if (
      moved.source === "sectionBoxEndpoints" &&
      Array.isArray(STATE.sectionBoxEndpoints) &&
      STATE.sectionBoxEndpoints.length >= 2 &&
      typeof openSectionBoxInspector === "function"
    ) {
      openSectionBoxInspector(STATE.sectionBoxEndpoints[0], STATE.sectionBoxEndpoints[1]);
      if (typeof applySectionBoxStateToClippingAndUI === "function") {
        applySectionBoxStateToClippingAndUI(false);
      }
    }
    if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
    if (moved.measType === "area" && Array.isArray(STATE.completedMeasurements)) {
      const m = STATE.completedMeasurements.find((item) => item && item.id === moved.measId);
      if (m && Array.isArray(m.points) && m.points.length >= 3) {
        let area2 = 0;
        let perim = 0;
        for (let i = 0; i < m.points.length; i++) {
          const a = m.points[i];
          const b = m.points[(i + 1) % m.points.length];
          area2 += a.x * b.z - b.x * a.z;
          perim += a.distanceTo(b);
        }
        const areaM2 = Math.abs(area2) * 0.5;
        const areaPing = areaM2 * 0.3025;
        showToast(
          tr(
            `✓ 已調整 ${moved.label} — 重新計算面積：${areaM2.toFixed(2)} m² (${areaPing.toFixed(2)} 坪) · 周長 ${perim.toFixed(2)} m`,
            `✓ Adjusted ${moved.label} — Recalculated Area: ${areaM2.toFixed(2)} m² (${areaPing.toFixed(2)} 坪) · Perim ${perim.toFixed(2)} m`
          )
        );
        return true;
      }
    }
    showToast(tr(`✓ 已更新點位位置 (${moved.label})`, `✓ Updated ${moved.label} position`));
    return true;
  }
  window.commitStudioVertexMove = commitStudioVertexMove;

  function cancelStudioVertexMove(showMsg = true) {
    if (!STATE.movingVertex) return false;
    const moved = STATE.movingVertex;
    if (moved.point && moved.originalPoint) {
      moved.point.copy(moved.originalPoint);
      if (
        moved.source === "cutFillPolygonPoints" &&
        Number.isFinite(moved.pointIndex) &&
        Array.isArray(STATE.maskBoundaryPoints) &&
        STATE.maskBoundaryPoints[moved.pointIndex]
      ) {
        STATE.maskBoundaryPoints[moved.pointIndex].copy(moved.originalPoint);
      }
    }
    STATE.movingVertex = null;
    updateStudioMovingVertexIndicator(null);
    syncStudioControlsForTool();
    rebuildAllCompletedMeasurements3D();
    if (
      moved.source === "cutFillPolygonPoints" &&
      Array.isArray(STATE.cutFillPolygonPoints) &&
      STATE.cutFillPolygonPoints.length >= 3 &&
      typeof drawPlacedCutFillPolygon3D === "function"
    ) {
      drawPlacedCutFillPolygon3D(STATE.cutFillPolygonPoints, STATE.lastVolumeResult);
    }
    if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
    if (showMsg) {
      showToast(tr("已取消移動點位（恢復原位置）", "Canceled point move (restored original position)"));
    }
    return true;
  }
  window.cancelStudioVertexMove = cancelStudioVertexMove;

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
      add3DPinMarker(pos, 0x0084ff, studioThree.overlayGroup, addObj);
    };

    const addLegRod = (start, end, colorHex) => {
      const lDir = new THREE.Vector3().subVectors(end, start);
      const lLen = lDir.length();
      if (lLen > 0.01) {
        const rodGeo = new THREE.CylinderGeometry(1, 1, lLen, 8);
        const rodMat = new THREE.MeshBasicMaterial({
          color: colorHex,
          depthTest: true,
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
    const lineMat = new THREE.LineBasicMaterial({ color: 0x0084ff, linewidth: 2, depthTest: true });
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
      new THREE.LineBasicMaterial({ color: 0xef4444, linewidth: 2, depthTest: true })
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
      new THREE.LineBasicMaterial({ color: 0x10b981, linewidth: 2, depthTest: true })
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
      new THREE.LineBasicMaterial({ color: 0x3b82f6, linewidth: 2, depthTest: true })
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


  // Interactive Dynamic Angle Visuals (3-Point: P1 -> Vertex P2 -> P3 with live legs, 3D sector arc & wedge)
  function renderAngleVisuals(dynamicPt = null, existingMeas = null) {
    if (!studioThree) return;
    const isTemp = !existingMeas;
    let p1 = null, p2 = null, p3 = null;

    if (existingMeas) {
      p1 = existingMeas.p1;
      p2 = existingMeas.p2;
      p3 = existingMeas.p3;
    } else {
      clearTempDistanceVisuals();
      const pts = STATE.measurePoints || [];
      if (pts.length === 0) {
        if (!dynamicPt) return;
        const addHoverObj = (mesh) => {
          studioThree.overlayGroup.add(mesh);
          STATE.tempDistanceObjects.push(mesh);
        };
        add3DPinMarker(dynamicPt, 0xf59e0b, studioThree.overlayGroup, addHoverObj);
        add2DBadge(
          dynamicPt,
          `<div class="autodesk-flex-badge autodesk-angle-badge">📐 起點 P1 <span class="autodesk-sub-pill">點擊設定第一邊</span></div>`,
          "#f59e0b",
          { rawHtml: true, offsetY: -24, isTempDistance: true }
        );
        updateZoomInvariantElements();
        return;
      } else if (pts.length === 1) {
        p1 = pts[0];
        p2 = dynamicPt;
      } else {
        p1 = pts[0];
        p2 = pts[1];
        p3 = dynamicPt || (pts.length >= 3 ? pts[2] : null);
      }
    }

    if (!p1) return;

    const addObj = (mesh) => {
      studioThree.overlayGroup.add(mesh);
      if (isTemp) STATE.tempDistanceObjects.push(mesh);
    };

    const addLegRod = (start, end, colorHex) => {
      const lDir = new THREE.Vector3().subVectors(end, start);
      const lLen = lDir.length();
      if (lLen > 0.01) {
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([start, end]),
          new THREE.LineBasicMaterial({ color: colorHex, linewidth: 2, depthTest: false })
        );
        line.renderOrder = 998;
        addObj(line);

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

    // Endpoint P1
    add3DPinMarker(p1, 0x0084ff, studioThree.overlayGroup, addObj);

    if (!p2) {
      add2DBadge(
        p1,
        `<div class="autodesk-flex-badge autodesk-angle-badge">起點 P1 <span class="autodesk-sub-pill">請點擊角頂點 P2</span></div>`,
        "#f59e0b",
        { rawHtml: true, offsetY: -22, isTempDistance: isTemp }
      );
      updateZoomInvariantElements();
      return;
    }

    // Vertex P2 (Amber highlight) + Leg 1 (P1 <-> P2)
    add3DPinMarker(p2, 0xf59e0b, studioThree.overlayGroup, addObj);
    const len1 = p1.distanceTo(p2);
    addLegRod(p2, p1, 0x0084ff);

    const mid1 = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
    if (len1 > 0.05) {
      add2DBadge(
        mid1,
        `<div class="autodesk-dist-badge">${formatGcDist(len1)}</div>`,
        "#0084ff",
        { rawHtml: true, isTempDistance: isTemp }
      );
    }

    // Compute true horizontal azimuths (0°-360° clockwise from North) at P1 and P3 from vertex P2
    const twd1 = localToTwd97(p1);
    const twd2 = localToTwd97(p2);
    const az1 = ((Math.atan2(twd1.e - twd2.e, twd1.n - twd2.n) * 180) / Math.PI + 360) % 360;

    if (!p3) {
      const horiz1 = Math.hypot(p2.x - p1.x, p2.z - p1.z);
      const slopePct = horiz1 > 0.05 ? (Math.abs(p2.y - p1.y) / horiz1) * 100 : 0;
      const v2Locked = isTemp && (STATE.measurePoints || []).length >= 2;
      const subPrompt = v2Locked
        ? `頂點已鎖定 · 移動滑鼠預覽夾角`
        : `坡度 ${slopePct.toFixed(1)}% · 點擊確認頂點 P2`;
      add2DBadge(
        p1,
        `<div class="autodesk-azimuth-badge">Az ${az1.toFixed(1)}°</div>`,
        "#f59e0b",
        { rawHtml: true, offsetY: -20, isTempDistance: isTemp }
      );
      add2DBadge(
        p2,
        `<div class="autodesk-flex-badge autodesk-angle-badge">頂點 P2 <span class="autodesk-sub-pill">${subPrompt}</span></div>`,
        "#f59e0b",
        { rawHtml: true, offsetY: -24, isTempDistance: isTemp }
      );
      updateZoomInvariantElements();
      return;
    }

    // Endpoint P3 + Leg 2 (P2 <-> P3)
    add3DPinMarker(p3, 0x0084ff, studioThree.overlayGroup, addObj);
    const len2 = p3.distanceTo(p2);
    addLegRod(p2, p3, 0x0084ff);

    const mid2 = new THREE.Vector3().addVectors(p2, p3).multiplyScalar(0.5);
    if (len2 > 0.05) {
      add2DBadge(
        mid2,
        `<div class="autodesk-dist-badge">${formatGcDist(len2)}</div>`,
        "#0084ff",
        { rawHtml: true, isTempDistance: isTemp }
      );
    }

    const twd3 = localToTwd97(p3);
    const az3 = ((Math.atan2(twd3.e - twd2.e, twd3.n - twd2.n) * 180) / Math.PI + 360) % 360;

    // Compute 3D interior angle at Vertex P2
    const u1 = p1.clone().sub(p2);
    const u2 = p3.clone().sub(p2);
    const l1Safe = Math.max(1e-6, u1.length());
    const l2Safe = Math.max(1e-6, u2.length());
    u1.divideScalar(l1Safe);
    u2.divideScalar(l2Safe);

    const cos3D = Math.max(-1, Math.min(1, u1.dot(u2)));
    const thetaRad = Math.acos(cos3D);
    const deg3D = THREE.MathUtils.radToDeg(thetaRad);
    if (existingMeas) {
      existingMeas.angleDeg = deg3D;
    }

    // Orthonormal basis (u1, wOrtho) in the P1-P2-P3 plane for 3D Sector Arc & Translucent Wedge
    const wOrtho = u2.clone().addScaledVector(u1, -cos3D);
    if (wOrtho.lengthSq() < 1e-8) {
      // Collinear fallback (0° or 180°): choose horizontal perpendicular
      wOrtho.set(-u1.z, 0, u1.x);
      if (wOrtho.lengthSq() < 1e-8) wOrtho.set(1, 0, 0);
    }
    wOrtho.normalize();

    const arcR = Math.max(0.14, Math.min(6.5, Math.min(l1Safe, l2Safe) * 0.30));
    const segs = 28;
    const arcPts = [];
    const fanPositions = [];

    for (let k = 0; k <= segs; k++) {
      const a = (k / segs) * thetaRad;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const ptArc = new THREE.Vector3(
        p2.x + arcR * (ca * u1.x + sa * wOrtho.x),
        p2.y + arcR * (ca * u1.y + sa * wOrtho.y),
        p2.z + arcR * (ca * u1.z + sa * wOrtho.z)
      );
      arcPts.push(ptArc);
      if (k > 0) {
        const prev = arcPts[k - 1];
        fanPositions.push(p2.x, p2.y, p2.z, prev.x, prev.y, prev.z, ptArc.x, ptArc.y, ptArc.z);
      }
    }

    const arcLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(arcPts),
      new THREE.LineBasicMaterial({ color: 0xf59e0b, linewidth: 2, depthTest: false })
    );
    arcLine.renderOrder = 999;
    addObj(arcLine);

    if (fanPositions.length >= 9) {
      const wedgeGeom = new THREE.BufferGeometry();
      wedgeGeom.setAttribute("position", new THREE.Float32BufferAttribute(fanPositions, 3));
      const wedgeMat = new THREE.MeshBasicMaterial({
        color: 0xf59e0b,
        transparent: true,
        opacity: 0.24,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      });
      const wedgeMesh = new THREE.Mesh(wedgeGeom, wedgeMat);
      wedgeMesh.renderOrder = 997;
      addObj(wedgeMesh);
    }

    const midAng = thetaRad * 0.5;
    const bisectorPt = new THREE.Vector3(
      p2.x + arcR * 1.18 * (Math.cos(midAng) * u1.x + Math.sin(midAng) * wOrtho.x),
      p2.y + arcR * 1.18 * (Math.cos(midAng) * u1.y + Math.sin(midAng) * wOrtho.y),
      p2.z + arcR * 1.18 * (Math.cos(midAng) * u1.z + Math.sin(midAng) * wOrtho.z)
    );

    // Show interior angle once at center point P2, and show azimuths at P1 and P3
    add2DBadge(
      bisectorPt,
      `<div class="autodesk-flex-badge autodesk-angle-badge"><span>${deg3D.toFixed(1)}°</span></div>`,
      "#f59e0b",
      { rawHtml: true, offsetY: -10, isTempDistance: isTemp }
    );
    add2DBadge(
      p1,
      `<div class="autodesk-azimuth-badge">Az ${az1.toFixed(1)}°</div>`,
      "#f59e0b",
      { rawHtml: true, offsetY: -20, isTempDistance: isTemp }
    );
    add2DBadge(
      p3,
      `<div class="autodesk-azimuth-badge">Az ${az3.toFixed(1)}°</div>`,
      "#f59e0b",
      { rawHtml: true, offsetY: -20, isTempDistance: isTemp }
    );

    updateZoomInvariantElements();
  }


  // Interactive Hover & Pinned Coordinate Visuals (Compact 4-Row Format: Name; E; N; H)
  function renderCoordinateVisuals(pt, existingMeas = null) {
    if (!studioThree || !pt) return;
    const isTemp = !existingMeas;
    if (isTemp) {
      clearTempDistanceVisuals();
    }
    const targetPt = existingMeas ? existingMeas.pt : pt;
    const twd = localToTwd97(targetPt);
    if (existingMeas) {
      existingMeas.twd = twd;
    }
    const isLocalCrs = !STATE.multiAlign?.active && inferActiveScanCrsCode(STATE.activeScan) === "LOCAL_ORIGIN";
    const axX = isLocalCrs ? "X" : "E";
    const axY = isLocalCrs ? "Y" : "N";
    const axZ = isLocalCrs ? "Z" : "H";
    const zSign = twd.h >= 0 ? "+" : "";

    const addObj = (mesh) => {
      studioThree.overlayGroup.add(mesh);
      if (isTemp) STATE.tempDistanceObjects.push(mesh);
    };

    add3DPinMarker(targetPt, isTemp ? 0x0ea5e9 : 0x10b981, studioThree.overlayGroup, addObj);

    const nextIdx = (STATE.completedMeasurements || []).filter((m) => m.type === "coordinates").length + 1;
    const ptName = existingMeas?.label || `P${nextIdx}`;
    add2DBadge(
      targetPt,
      `<div class="autodesk-flex-badge autodesk-coord-badge ${isTemp ? "" : "pinned"}">` +
        `<div class="coord-row coord-row-name">${escapeHtml(ptName)}</div>` +
        `<div class="coord-row">${axX} ${twd.e.toFixed(2)}</div>` +
        `<div class="coord-row">${axY} ${twd.n.toFixed(2)}</div>` +
        `<div class="coord-row">${axZ} ${zSign}${twd.h.toFixed(2)} m</div>` +
      `</div>`,
      isTemp ? "#38bdf8" : "#10b981",
      { rawHtml: true, offsetY: -26, isTempDistance: isTemp }
    );

    updateZoomInvariantElements();
  }

  // Section Box Unclipped Material & 3D Triangle Clipping Evaluation Helpers
  function makeUnclippedMaterial(mat) {
    if (!mat) return mat;
    mat.clippingPlanes = [];
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace("#include <clipping_planes_fragment>", "");
    };
    mat.customProgramCacheKey = () => "gs_unclipped_v1";
    return mat;
  }

  function isSectionBoxClippingActive() {
    return Boolean(
      STATE.sectionBoxState &&
        STATE.sectionBoxState.active &&
        studioThree?.renderer?.clippingPlanes &&
        studioThree.renderer.clippingPlanes.length > 0
    );
  }

  function getSerializedActiveSectionBox() {
    if (!isSectionBoxClippingActive()) return null;
    const sb = STATE.sectionBoxState;
    return {
      center: [
        Math.round((Number(sb.centerX) || 0) * 10000) / 10000,
        Math.round((Number(sb.centerY) || 0) * 10000) / 10000,
        Math.round((Number(sb.centerZ) || 0) * 10000) / 10000,
      ],
      half: [
        Math.round(Math.max(0.1, Number(sb.halfX) || 10) * 10000) / 10000,
        Math.round(Math.max(0.1, Number(sb.halfY) || 10) * 10000) / 10000,
        Math.round(Math.max(0.1, Number(sb.halfZ) || 10) * 10000) / 10000,
      ],
      yaw_rad: Math.round((Number(sb.yawRad) || 0) * 100000) / 100000,
    };
  }

  function parseSectionBoxForEval(rawSb) {
    if (!rawSb || typeof rawSb !== "object") return null;
    if (Array.isArray(rawSb.center) && Array.isArray(rawSb.half)) {
      const yaw = Number(rawSb.yaw_rad) || 0;
      return {
        cx: Number(rawSb.center[0]) || 0,
        cy: Number(rawSb.center[1]) || 0,
        cz: Number(rawSb.center[2]) || 0,
        hx: Math.max(0.05, Number(rawSb.half[0]) || 10),
        hy: Math.max(0.05, Number(rawSb.half[1]) || 10),
        hz: Math.max(0.05, Number(rawSb.half[2]) || 10),
        cosY: Math.cos(yaw),
        sinY: Math.sin(yaw),
      };
    }
    if (rawSb.active) {
      const yaw = Number(rawSb.yawRad) || 0;
      return {
        cx: Number(rawSb.centerX) || 0,
        cy: Number(rawSb.centerY) || 0,
        cz: Number(rawSb.centerZ) || 0,
        hx: Math.max(0.05, Number(rawSb.halfX) || 10),
        hy: Math.max(0.05, Number(rawSb.halfY) || 10),
        hz: Math.max(0.05, Number(rawSb.halfZ) || 10),
        cosY: Math.cos(yaw),
        sinY: Math.sin(yaw),
      };
    }
    return null;
  }

  function isPointInSectionBox(wx, wy, wz, sb) {
    if (!sb) return true;
    const dy = wy - sb.cy;
    if (Math.abs(dy) > sb.hy + 1e-4) return false;
    const dx = wx - sb.cx;
    const dz = wz - sb.cz;
    const lx = dx * sb.cosY - dz * sb.sinY;
    if (Math.abs(lx) > sb.hx + 1e-4) return false;
    const lz = dx * sb.sinY + dz * sb.cosY;
    return Math.abs(lz) <= sb.hz + 1e-4;
  }

  function isTriangleInSectionBox(wx0, wy0, wz0, wx1, wy1, wz1, wx2, wy2, wz2, sb) {
    if (!sb) return true;
    const wxc = (wx0 + wx1 + wx2) / 3.0;
    const wyc = (wy0 + wy1 + wy2) / 3.0;
    const wzc = (wz0 + wz1 + wz2) / 3.0;
    if (isPointInSectionBox(wxc, wyc, wzc, sb)) return true;
    let vIn = 0;
    if (isPointInSectionBox(wx0, wy0, wz0, sb)) vIn++;
    if (isPointInSectionBox(wx1, wy1, wz1, sb)) vIn++;
    if (vIn < 2 && isPointInSectionBox(wx2, wy2, wz2, sb)) vIn++;
    return vIn >= 2;
  }


