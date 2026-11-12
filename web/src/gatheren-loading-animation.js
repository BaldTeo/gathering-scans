/**
 * Gatheren Cloud — Standalone Two-Phase Loading Animation Module
 * File: gatheren-loading-animation.js
 *
 * Drop-in, zero-dependency animation component for Gatheren Cloud web properties
 * (files.gatheren.cloud, gatheren.cloud, scans.gatheren.cloud, etc.).
 *
 * Phase 1 (Looping Loading State):
 *   - 10 blue-to-green gradient-outline clouds drift along horizontal wind currents
 *     on a background layer behind the central Gathering Cloud logo.
 *   - The central logo gently breathes in luminance and soft cyan-emerald glow.
 *
 * Phase 2 (Completion & Fly-to-Header Transition):
 *   - Step 2A (Cloud Convergence, ~320ms): All floating clouds curve inward into
 *     the cloud part of the central house emblem with a brief luminous merge pulse.
 *   - Step 2B (Fly to Top-Left Header, ~380ms): The unified logo scales down and
 *     flies smoothly into the top-left navbar logo slot (.top-navbar .brand-cluster)
 *     while the loading backdrop fades out, handing off seamlessly.
 *
 * Phase 3 (Task Action Cloud & Trophy Burst):
 *   - GatherenLoader.burstClouds({ includeTrophy: false }) spawns clouds flying
 *     outward to all sides when a task is created or a comment is added.
 *   - GatherenLoader.burstClouds({ includeTrophy: true }) mixes flying clouds with
 *     trophy emojis of roughly the same size when a task is marked as "done".
 *
 * Quick Integration on Any Website:
 *   1. Include js/gatheren-loading-animation.js in your HTML page.
 *   2. Start Phase 1 loading loop:
 *        GatherenLoader.start({ targetSelector: '.top-navbar .brand-cluster' });
 *   3. When your app finishes loading data, trigger Phase 2 convergence & fly-to-header:
 *        await GatherenLoader.complete();
 */
(function (root) {
  "use strict";

  var CLOUD_SPRITE_DATA_URI = "data:image/png;base64,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";
  var CLOUD_BASE_W = 238;
  var CLOUD_BASE_H = 158;

  var _completeCloudUriCache = { light: null, dark: null };
  var _spritePreloadImg = null;
  if (typeof Image !== "undefined") {
    _spritePreloadImg = new Image();
    _spritePreloadImg.src = CLOUD_SPRITE_DATA_URI;
  }

  function buildFilledCompleteCloudUri(theme) {
    var key = theme === "dark" ? "dark" : "light";
    if (_completeCloudUriCache[key]) return _completeCloudUriCache[key];
    if (typeof document === "undefined" || !_spritePreloadImg || !_spritePreloadImg.complete || !_spritePreloadImg.naturalWidth) {
      return null;
    }
    try {
      var c = document.createElement("canvas");
      c.width = CLOUD_BASE_W;
      c.height = CLOUD_BASE_H;
      var ctx = c.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(_spritePreloadImg, 0, 0, CLOUD_BASE_W, CLOUD_BASE_H);
      var imgData = ctx.getImageData(0, 0, CLOUD_BASE_W, CLOUD_BASE_H);
      var d = imgData.data;
      var total = CLOUD_BASE_W * CLOUD_BASE_H;
      var visited = new Uint8Array(total);
      var queue = new Int32Array(total);
      var head = 0;
      var tail = 0;
      var startIdx = 95 * CLOUD_BASE_W + 119;
      visited[startIdx] = 1;
      queue[tail++] = startIdx;
      var fr = key === "dark" ? 15 : 255;
      var fg = key === "dark" ? 23 : 255;
      var fb = key === "dark" ? 42 : 255;
      var fa = key === "dark" ? 0.95 : 0.97;
      while (head < tail) {
        var cur = queue[head++];
        var p = cur * 4;
        var sa = d[p + 3] / 255;
        var inv = 1 - sa;
        var outA = sa + fa * inv;
        if (outA > 0) {
          d[p] = Math.round((d[p] * sa + fr * fa * inv) / outA);
          d[p + 1] = Math.round((d[p + 1] * sa + fg * fa * inv) / outA);
          d[p + 2] = Math.round((d[p + 2] * sa + fb * fa * inv) / outA);
          d[p + 3] = Math.round(outA * 255);
        }
        var x = cur % CLOUD_BASE_W;
        var y = (cur - x) / CLOUD_BASE_W;
        if (x > 0) {
          var l = cur - 1;
          if (!visited[l] && d[l * 4 + 3] < 200) { visited[l] = 1; queue[tail++] = l; }
        }
        if (x + 1 < CLOUD_BASE_W) {
          var r = cur + 1;
          if (!visited[r] && d[r * 4 + 3] < 200) { visited[r] = 1; queue[tail++] = r; }
        }
        if (y > 0) {
          var u = cur - CLOUD_BASE_W;
          if (!visited[u] && d[u * 4 + 3] < 200) { visited[u] = 1; queue[tail++] = u; }
        }
        if (y + 1 < CLOUD_BASE_H) {
          var dn = cur + CLOUD_BASE_W;
          if (!visited[dn] && d[dn * 4 + 3] < 200) { visited[dn] = 1; queue[tail++] = dn; }
        }
      }
      ctx.putImageData(imgData, 0, 0);
      var uri = c.toDataURL("image/png");
      _completeCloudUriCache[key] = uri;
      return uri;
    } catch (_) {
      return null;
    }
  }

  function applyCompleteCloudSprite(cloudImgEl, textEl) {
    var curTheme = detectActiveTheme();
    if (textEl) {
      if (curTheme === "dark") {
        textEl.style.color = "#f8fafc";
        textEl.style.textShadow = "0 1px 2px rgba(2, 6, 23, 0.92), 0 2px 10px rgba(56, 189, 248, 0.28)";
      } else {
        textEl.style.color = "#0f172a";
        textEl.style.textShadow = "0 1px 0 rgba(255, 255, 255, 0.9), 0 2px 8px rgba(14, 165, 233, 0.22)";
      }
    }
    var filled = buildFilledCompleteCloudUri(curTheme);
    if (filled) {
      cloudImgEl.src = filled;
    } else {
      cloudImgEl.src = CLOUD_SPRITE_DATA_URI;
      if (_spritePreloadImg && !_spritePreloadImg.complete) {
        _spritePreloadImg.addEventListener("load", function onReady() {
          _spritePreloadImg.removeEventListener("load", onReady);
          var lateUri = buildFilledCompleteCloudUri(curTheme);
          if (lateUri && cloudImgEl) cloudImgEl.src = lateUri;
        });
      }
    }
  }

  // Inner cloud relative position inside the horizontal Gathering Cloud logo (1024x411)
  var INNER_CLOUD_X_RATIO = 0.212;
  var INNER_CLOUD_Y_RATIO = 0.545;
  var INNER_CLOUD_W_RATIO = 0.232;

  // 10 Floating clouds configuration (normalized around 1920x1080 reference center 960, 540)
  var CLOUDS_TEMPLATE = [
    { ox: -510, oy: -210, ax: 35, ay: 14, freq: 1.3, phase: 0.2, scale: 0.72, opacity: 0.90 },
    { ox: -230, oy: -260, ax: 28, ay: 12, freq: 1.1, phase: 1.4, scale: 0.76, opacity: 0.94 },
    { ox:  150, oy: -255, ax: 32, ay: 15, freq: 1.4, phase: 2.5, scale: 0.70, opacity: 0.88 },
    { ox:  330, oy: -315, ax: 30, ay: 11, freq: 1.2, phase: 3.8, scale: 0.74, opacity: 0.95 },
    { ox:  500, oy: -190, ax: 36, ay: 13, freq: 1.0, phase: 4.9, scale: 0.72, opacity: 0.90 },
    { ox: -565, oy:   20, ax: 40, ay: 16, freq: 1.5, phase: 0.9, scale: 0.75, opacity: 0.92 },
    { ox: -475, oy:  210, ax: 30, ay: 14, freq: 1.2, phase: 2.1, scale: 0.74, opacity: 0.92 },
    { ox:  -95, oy:  270, ax: 34, ay: 12, freq: 1.3, phase: 3.3, scale: 0.71, opacity: 0.89 },
    { ox:  105, oy:  215, ax: 32, ay: 15, freq: 1.1, phase: 4.4, scale: 0.75, opacity: 0.94 },
    { ox:  480, oy:  200, ax: 28, ay: 13, freq: 1.4, phase: 5.5, scale: 0.73, opacity: 0.91 }
  ];

  function easeInOutCubic(t) {
    var clamped = Math.max(0, Math.min(1, t));
    return clamped < 0.5
      ? 4 * clamped * clamped * clamped
      : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
  }

  function injectScopedStyles() {
    if (document.querySelector("style[data-gatheren-loader-styles]")) return;
    var style = document.createElement("style");
    style.setAttribute("data-gatheren-loader-styles", "1");
    style.textContent = [
      ".gatheren-loading-overlay {",
      "  position: fixed;",
      "  inset: 0;",
      "  z-index: 95000;",
      "  overflow: hidden;",
      "  pointer-events: all;",
      "  user-select: none;",
      "  -webkit-user-select: none;",
      "  display: block;",
      "}",
      ".gatheren-loading-overlay.hidden {",
      "  display: none !important;",
      "  visibility: hidden !important;",
      "  pointer-events: none !important;",
      "}",
      ".gatheren-loading-backdrop {",
      "  position: absolute;",
      "  inset: 0;",
      "  background: #0b101b;",
      "  backdrop-filter: blur(10px);",
      "  -webkit-backdrop-filter: blur(10px);",
      "  transition: background-color 0.2s ease;",
      "  will-change: opacity;",
      "}",
      ".gatheren-loading-overlay[data-loader-theme='light'] .gatheren-loading-backdrop {",
      "  background: #f8fafc;",
      "}",
      ".gatheren-loading-clouds-layer {",
      "  position: absolute;",
      "  inset: 0;",
      "  z-index: 1;",
      "  pointer-events: none;",
      "}",
      ".gatheren-loading-cloud {",
      "  position: absolute;",
      "  top: 0;",
      "  left: 0;",
      "  transform-origin: center center;",
      "  will-change: transform, opacity;",
      "  pointer-events: none;",
      "}",
      ".gatheren-loading-aura {",
      "  position: absolute;",
      "  top: 0;",
      "  left: 0;",
      "  z-index: 1;",
      "  border-radius: 50%;",
      "  pointer-events: none;",
      "  filter: blur(36px);",
      "  -webkit-filter: blur(36px);",
      "  will-change: transform, opacity, width, height;",
      "}",
      ".gatheren-loading-merge-pulse {",
      "  position: absolute;",
      "  top: 0;",
      "  left: 0;",
      "  z-index: 2;",
      "  border-radius: 50%;",
      "  pointer-events: none;",
      "  background: radial-gradient(circle, rgba(139, 195, 74, 0.65) 0%, rgba(56, 189, 248, 0.35) 55%, rgba(56, 189, 248, 0) 100%);",
      "  filter: blur(18px);",
      "  -webkit-filter: blur(18px);",
      "  opacity: 0;",
      "  will-change: transform, opacity;",
      "}",
      ".gatheren-loading-logo-wrap {",
      "  position: absolute;",
      "  top: 0;",
      "  left: 0;",
      "  z-index: 3;",
      "  transform-origin: top left;",
      "  will-change: transform, width, height, filter, opacity;",
      "  pointer-events: none;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "}",
      ".gatheren-loading-logo-img {",
      "  width: 100%;",
      "  height: 100%;",
      "  object-fit: contain;",
      "  display: block;",
      "}",
      ".gatheren-burst-layer {",
      "  position: fixed;",
      "  inset: 0;",
      "  z-index: 96000;",
      "  pointer-events: none;",
      "  overflow: hidden;",
      "  user-select: none;",
      "  -webkit-user-select: none;",
      "}",
      ".gatheren-burst-item {",
      "  position: absolute;",
      "  top: 0;",
      "  left: 0;",
      "  pointer-events: none;",
      "  will-change: transform, opacity;",
      "  transform-origin: center center;",
      "}",
      ".gatheren-burst-trophy {",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  line-height: 1;",
      "  filter: drop-shadow(0 6px 16px rgba(245, 158, 11, 0.48));",
      "}",
      ".gatheren-task-complete-popup {",
      "  position: fixed;",
      "  top: 50%;",
      "  left: 50%;",
      "  z-index: 96500;",
      "  pointer-events: none;",
      "  user-select: none;",
      "  -webkit-user-select: none;",
      "  transform: translate3d(-50%, -50%, 0) scale(0.4);",
      "  opacity: 0;",
      "  will-change: transform, opacity;",
      "}",
      ".gatheren-complete-aura {",
      "  position: absolute;",
      "  inset: -18%;",
      "  border-radius: 50%;",
      "  background: radial-gradient(circle, rgba(250, 204, 21, 0.34) 0%, rgba(56, 189, 248, 0.24) 48%, rgba(16, 185, 129, 0) 74%);",
      "  filter: blur(24px);",
      "  -webkit-filter: blur(24px);",
      "  z-index: 1;",
      "}",
      ".gatheren-complete-big-trophy {",
      "  position: absolute;",
      "  z-index: 2;",
      "  line-height: 1;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  filter: drop-shadow(0 14px 28px rgba(245, 158, 11, 0.55));",
      "  transform-origin: center bottom;",
      "}",
      ".gatheren-complete-cloud-wrap {",
      "  position: absolute;",
      "  z-index: 3;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  filter: drop-shadow(0 12px 26px rgba(15, 23, 42, 0.42));",
      "}",
      ".gatheren-complete-cloud-img {",
      "  width: 100%;",
      "  height: 100%;",
      "  object-fit: contain;",
      "  display: block;",
      "}",
      ".gatheren-complete-cloud-text {",
      "  position: absolute;",
      "  top: 57%;",
      "  left: 51%;",
      "  transform: translate(-50%, -50%);",
      "  width: 78%;",
      "  text-align: center;",
      "  font-weight: 800;",
      "  letter-spacing: 0.02em;",
      "  line-height: 1.15;",
      "  color: #0f172a;",
      "  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.9), 0 2px 8px rgba(14, 165, 233, 0.22);",
      "  white-space: nowrap;",
      "}",
      "#studioDetailStreamBar, #previewDetailStreamBar, #volProgressBar, #catProgressBar, #contoursProgressBar, #studioVolProgressHudFill {",
      "  transition: width 0.28s cubic-bezier(0.22, 1, 0.36, 1) !important;",
      "}",
      "@keyframes gsResultReadyPulse {",
      "  0% { transform: translate3d(0, 3px, 0) scale(0.992); box-shadow: 0 0 0 0 rgba(56, 189, 248, 0), 0 0 0 0 rgba(16, 185, 129, 0); }",
      "  38% { transform: translate3d(0, 0, 0) scale(1.004); box-shadow: 0 0 0 1.5px rgba(56, 189, 248, 0.58), 0 10px 26px -6px rgba(16, 185, 129, 0.28); }",
      "  100% { transform: translate3d(0, 0, 0) scale(1); box-shadow: 0 0 0 0 rgba(56, 189, 248, 0), 0 0 0 0 rgba(16, 185, 129, 0); }",
      "}",
      "@keyframes gsResultReadySheen {",
      "  0% { transform: translateX(-115%) skewX(-18deg); opacity: 0; }",
      "  28% { opacity: 0.72; }",
      "  100% { transform: translateX(125%) skewX(-18deg); opacity: 0; }",
      "}",
      ".gs-result-ready-pulse {",
      "  position: relative;",
      "  overflow: hidden;",
      "  border-radius: 8px;",
      "  animation: gsResultReadyPulse 0.68s cubic-bezier(0.22, 1, 0.36, 1) both;",
      "}",
      ".gs-result-ready-pulse::after {",
      "  content: '';",
      "  position: absolute;",
      "  inset: 0;",
      "  border-radius: inherit;",
      "  pointer-events: none;",
      "  background: linear-gradient(90deg, rgba(56, 189, 248, 0) 0%, rgba(56, 189, 248, 0.16) 44%, rgba(16, 185, 129, 0.22) 56%, rgba(56, 189, 248, 0) 100%);",
      "  animation: gsResultReadySheen 0.68s cubic-bezier(0.22, 1, 0.36, 1) both;",
      "}",
      "@keyframes gsCardSlideFadeIn {",
      "  0% { opacity: 0; transform: translate3d(0, 5px, 0); }",
      "  100% { opacity: 1; transform: translate3d(0, 0, 0); }",
      "}",
      ".timeline-scan-card, .gs-lib-card, .gs-bookmark-card, #sidePanelContent > .gs-metric-grid, #sidePanelContent .gs-metric-box {",
      "  animation: gsCardSlideFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) both;",
      "}",
      ".timeline-scan-card:nth-child(2), .gs-lib-card:nth-child(2), .gs-metric-box:nth-child(2) { animation-delay: 0.025s; }",
      ".timeline-scan-card:nth-child(3), .gs-lib-card:nth-child(3), .gs-metric-box:nth-child(3) { animation-delay: 0.05s; }",
      ".timeline-scan-card:nth-child(4), .gs-lib-card:nth-child(4), .gs-metric-box:nth-child(4) { animation-delay: 0.075s; }"
    ].join("\n");
    document.head.appendChild(style);
  }

  function detectActiveTheme(explicitTheme) {
    if (explicitTheme === "light" || explicitTheme === "dark") {
      return explicitTheme;
    }
    var htmlTheme = document.documentElement && document.documentElement.getAttribute("data-theme");
    if (htmlTheme === "light" || htmlTheme === "dark") return htmlTheme;
    var bodyTheme = document.body && document.body.getAttribute("data-theme");
    if (bodyTheme === "light" || bodyTheme === "dark") return bodyTheme;
    if (root.STATE && (root.STATE.resolvedTheme === "light" || root.STATE.resolvedTheme === "dark")) {
      return root.STATE.resolvedTheme;
    }
    if (root.AppState && (root.AppState.theme === "light" || root.AppState.theme === "dark")) {
      return root.AppState.theme;
    }
    return "dark";
  }

  function discoverLogoSources(opts) {
    var darkEl = document.querySelector(".top-navbar .brand-logo-dark, .brand-logo-dark, .gs-logo-dark");
    var lightEl = document.querySelector(".top-navbar .brand-logo-light, .brand-logo-light, .gs-logo-light");
    return {
      dark: (opts && opts.logoDarkSrc) || (darkEl && darkEl.getAttribute("src")) || "/assets/logo_dark.png?v=20261112_v322",
      light: (opts && opts.logoLightSrc) || (lightEl && lightEl.getAttribute("src")) || "/assets/logo_transparent.png?v=20261112_v322"
    };
  }

  function findTargetLogoElement(targetSelector) {
    var selectors = [];
    if (targetSelector) selectors.push(targetSelector);
    selectors.push(
      ".top-navbar .brand-cluster .brand-logo-img",
      ".top-navbar .brand-cluster",
      ".gs-topbar .brand-cluster .brand-logo-img",
      ".gs-topbar .brand-cluster",
      ".brand-cluster .brand-logo-img",
      ".brand-cluster",
      ".gs-brand",
      ".brand-logo"
    );
    for (var i = 0; i < selectors.length; i++) {
      var nodes = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        var style = window.getComputedStyle(el);
        if (style.display !== "none" && style.visibility !== "hidden") {
          var rect = el.getBoundingClientRect();
          if (rect.width > 4 && rect.height > 4) {
            return { element: el, rect: rect };
          }
        }
      }
    }
    return null;
  }

  var state = {
    active: false,
    phase: "idle", // "idle" | "looping" | "converging" | "flying"
    rafId: null,
    fallbackTimerId: null,
    startTimeMs: 0,
    phaseStartTimeMs: 0,
    minLoopDurationMs: 0,
    convergeDurationMs: 320,
    flyDurationMs: 380,
    targetSelector: ".top-navbar .brand-cluster",
    theme: "dark",
    logoSources: { dark: "/assets/logo_dark.png?v=20261112_v322", light: "/assets/logo_transparent.png?v=20261112_v322" },
    overlayEl: null,
    backdropEl: null,
    cloudsLayerEl: null,
    cloudEls: [],
    auraEl: null,
    mergePulseEl: null,
    logoWrapEl: null,
    logoImgEl: null,
    hiddenNavLogoEl: null,
    hiddenNavLogoOrigOpacity: "",
    convergeStartStates: [],
    completePromise: null,
    completeResolve: null,
    pendingCompleteTimer: null
  };

  function ensureOverlayDom() {
    injectScopedStyles();
    var overlay = document.getElementById("gatherenLoadingOverlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "gatherenLoadingOverlay";
      overlay.className = "gatheren-loading-overlay hidden";
      overlay.setAttribute("aria-hidden", "true");
      document.body.appendChild(overlay);
    }

    if (!overlay.querySelector(".gatheren-loading-backdrop")) {
      overlay.innerHTML = "";
      var backdrop = document.createElement("div");
      backdrop.className = "gatheren-loading-backdrop";

      var aura = document.createElement("div");
      aura.className = "gatheren-loading-aura";

      var cloudsLayer = document.createElement("div");
      cloudsLayer.className = "gatheren-loading-clouds-layer";

      var cloudEls = [];
      for (var i = 0; i < CLOUDS_TEMPLATE.length; i++) {
        var cImg = document.createElement("img");
        cImg.className = "gatheren-loading-cloud";
        cImg.src = CLOUD_SPRITE_DATA_URI;
        cImg.alt = "";
        cImg.setAttribute("aria-hidden", "true");
        cloudsLayer.appendChild(cImg);
        cloudEls.push(cImg);
      }

      var mergePulse = document.createElement("div");
      mergePulse.className = "gatheren-loading-merge-pulse";

      var logoWrap = document.createElement("div");
      logoWrap.className = "gatheren-loading-logo-wrap";
      var logoImg = document.createElement("img");
      logoImg.className = "gatheren-loading-logo-img";
      logoImg.alt = "Gathering Cloud";
      logoWrap.appendChild(logoImg);

      overlay.appendChild(backdrop);
      overlay.appendChild(aura);
      overlay.appendChild(cloudsLayer);
      overlay.appendChild(mergePulse);
      overlay.appendChild(logoWrap);

      state.backdropEl = backdrop;
      state.auraEl = aura;
      state.cloudsLayerEl = cloudsLayer;
      state.cloudEls = cloudEls;
      state.mergePulseEl = mergePulse;
      state.logoWrapEl = logoWrap;
      state.logoImgEl = logoImg;
    } else if (!state.backdropEl) {
      state.backdropEl = overlay.querySelector(".gatheren-loading-backdrop");
      state.auraEl = overlay.querySelector(".gatheren-loading-aura");
      state.cloudsLayerEl = overlay.querySelector(".gatheren-loading-clouds-layer");
      state.cloudEls = Array.prototype.slice.call(overlay.querySelectorAll(".gatheren-loading-cloud"));
      state.mergePulseEl = overlay.querySelector(".gatheren-loading-merge-pulse");
      state.logoWrapEl = overlay.querySelector(".gatheren-loading-logo-wrap");
      state.logoImgEl = overlay.querySelector(".gatheren-loading-logo-img");
    }

    state.overlayEl = overlay;
    return overlay;
  }

  function computeLayoutMetrics() {
    var vw = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 1280);
    var vh = Math.max(240, window.innerHeight || document.documentElement.clientHeight || 720);
    var scaleFactor = Math.min(1.0, Math.max(0.46, Math.min(vw / 1600, vh / 920)));
    var centerLw = Math.round(620 * scaleFactor);
    var centerLh = Math.round(centerLw * (411 / 1024));
    var centerLx = vw / 2;
    var centerLy = vh / 2;

    var innerCloudCx = (centerLx - centerLw / 2) + centerLw * INNER_CLOUD_X_RATIO;
    var innerCloudCy = (centerLy - centerLh / 2) + centerLh * INNER_CLOUD_Y_RATIO;
    var innerCloudScale = (centerLw * INNER_CLOUD_W_RATIO) / CLOUD_BASE_W;

    return {
      vw: vw,
      vh: vh,
      scaleFactor: scaleFactor,
      centerLw: centerLw,
      centerLh: centerLh,
      centerLx: centerLx,
      centerLy: centerLy,
      innerCloudCx: innerCloudCx,
      innerCloudCy: innerCloudCy,
      innerCloudScale: innerCloudScale
    };
  }

  function getCloudPhase1Position(cfg, tSec, metrics) {
    var sf = metrics.scaleFactor;
    var dx = Math.sin(tSec * 0.75 + cfg.phase) * 95 * sf + Math.cos(tSec * 0.42 + cfg.phase * 1.7) * cfg.ax * sf;
    var dy = Math.sin(tSec * cfg.freq + cfg.phase) * cfg.ay * sf;
    return {
      cx: metrics.centerLx + cfg.ox * sf + dx,
      cy: metrics.centerLy + cfg.oy * sf + dy,
      scale: cfg.scale * sf,
      opacity: cfg.opacity
    };
  }

  function restoreNavLogoVisibility() {
    if (state.hiddenNavLogoEl) {
      state.hiddenNavLogoEl.style.opacity = state.hiddenNavLogoOrigOpacity;
      state.hiddenNavLogoEl = null;
      state.hiddenNavLogoOrigOpacity = "";
    }
  }

  function scheduleNextTick() {
    if (!state.active) return;
    if (state.rafId) {
      window.cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    if (state.fallbackTimerId) {
      clearTimeout(state.fallbackTimerId);
      state.fallbackTimerId = null;
    }
    state.rafId = window.requestAnimationFrame(function () {
      renderFrame();
    });
    state.fallbackTimerId = setTimeout(function () {
      renderFrame();
    }, 32);
  }

  function renderFrame() {
    if (!state.active) return;
    var nowMs = performance.now();

    var currentTheme = detectActiveTheme();
    if (currentTheme !== state.theme) {
      state.theme = currentTheme;
      state.overlayEl.setAttribute("data-loader-theme", currentTheme);
      var targetSrc = currentTheme === "light" ? state.logoSources.light : state.logoSources.dark;
      if (state.logoImgEl && state.logoImgEl.getAttribute("src") !== targetSrc) {
        state.logoImgEl.src = targetSrc;
      }
    }

    var tSec = (nowMs - state.startTimeMs) / 1000;
    var metrics = computeLayoutMetrics();
    var centerLx = metrics.centerLx;
    var centerLy = metrics.centerLy;
    var centerLw = metrics.centerLw;
    var centerLh = metrics.centerLh;

    var overlayAlpha = 1.0;
    var curLx = centerLx;
    var curLy = centerLy;
    var curLw = centerLw;
    var curLh = centerLh;
    var breathe = 0.5 + 0.5 * Math.sin(tSec * 2.6 - 0.5);
    var mergeBoost = 0.0;

    if (state.phase === "looping") {
      for (var i = 0; i < CLOUDS_TEMPLATE.length; i++) {
        var pos = getCloudPhase1Position(CLOUDS_TEMPLATE[i], tSec, metrics);
        var cw = CLOUD_BASE_W * pos.scale;
        var ch = CLOUD_BASE_H * pos.scale;
        var el = state.cloudEls[i];
        el.style.width = cw.toFixed(1) + "px";
        el.style.height = ch.toFixed(1) + "px";
        el.style.opacity = pos.opacity.toFixed(3);
        el.style.transform = "translate3d(" + (pos.cx - cw / 2).toFixed(1) + "px, " + (pos.cy - ch / 2).toFixed(1) + "px, 0)";
      }
      state.mergePulseEl.style.opacity = "0";
    } else if (state.phase === "converging") {
      var convElapsed = nowMs - state.phaseStartTimeMs;
      var rawP = Math.max(0, Math.min(1, convElapsed / Math.max(1, state.convergeDurationMs)));

      for (var j = 0; j < CLOUDS_TEMPLATE.length; j++) {
        var stagger = (j % 4) * 0.06;
        var localP = Math.max(0, Math.min(1, (rawP - stagger) / (1 - stagger)));
        var ep = easeInOutCubic(localP);
        var startSt = state.convergeStartStates[j] || getCloudPhase1Position(CLOUDS_TEMPLATE[j], tSec, metrics);
        var arcY = -28 * metrics.scaleFactor * Math.sin(Math.PI * ep) * (startSt.cy < metrics.innerCloudCy ? 1 : -1);
        var cx = startSt.cx + (metrics.innerCloudCx - startSt.cx) * ep;
        var cy = startSt.cy + (metrics.innerCloudCy - startSt.cy) * ep + arcY;
        var sc = startSt.scale + (metrics.innerCloudScale - startSt.scale) * ep;
        var op = startSt.opacity * (ep < 0.8 ? 1.0 : Math.max(0, (1.0 - ep) / 0.2));

        var cw2 = CLOUD_BASE_W * sc;
        var ch2 = CLOUD_BASE_H * sc;
        var el2 = state.cloudEls[j];
        el2.style.width = cw2.toFixed(1) + "px";
        el2.style.height = ch2.toFixed(1) + "px";
        el2.style.opacity = op.toFixed(3);
        el2.style.transform = "translate3d(" + (cx - cw2 / 2).toFixed(1) + "px, " + (cy - ch2 / 2).toFixed(1) + "px, 0)";
      }

      mergeBoost = Math.pow(Math.sin(Math.PI * Math.max(0, (rawP - 0.35) / 0.65)), 2);
      var mRad = centerLw * 0.34;
      state.mergePulseEl.style.width = mRad.toFixed(1) + "px";
      state.mergePulseEl.style.height = mRad.toFixed(1) + "px";
      state.mergePulseEl.style.opacity = (mergeBoost * 0.92).toFixed(3);
      state.mergePulseEl.style.transform =
        "translate3d(" + (metrics.innerCloudCx - mRad / 2).toFixed(1) + "px, " + (metrics.innerCloudCy - mRad / 2).toFixed(1) + "px, 0)";

      if (rawP >= 1.0) {
        // Transition to Phase 2B: Fly to Top-Left Header
        state.phase = "flying";
        state.phaseStartTimeMs = nowMs;
        for (var k = 0; k < state.cloudEls.length; k++) {
          state.cloudEls[k].style.opacity = "0";
        }
        var targetInfo = findTargetLogoElement(state.targetSelector);
        if (targetInfo && targetInfo.element) {
          state.hiddenNavLogoEl = targetInfo.element;
          state.hiddenNavLogoOrigOpacity = targetInfo.element.style.opacity || "";
          targetInfo.element.style.opacity = "0";
        }
      }
    } else if (state.phase === "flying") {
      var flyElapsed = nowMs - state.phaseStartTimeMs;
      var pFly = Math.max(0, Math.min(1, flyElapsed / Math.max(1, state.flyDurationMs)));
      var epFly = easeInOutCubic(pFly);

      var target = findTargetLogoElement(state.targetSelector);
      var navLh = 28;
      var navLw = Math.round(navLh * (1024 / 411));
      var navLx = 16 + navLw / 2;
      var navLy = 26;
      if (target && target.rect) {
        navLw = target.rect.width;
        navLh = target.rect.height;
        navLx = target.rect.left + navLw / 2;
        navLy = target.rect.top + navLh / 2;
      }

      curLx = centerLx + (navLx - centerLx) * epFly;
      curLy = centerLy + (navLy - centerLy) * epFly;
      curLw = centerLw + (navLw - centerLw) * epFly;
      curLh = centerLh + (navLh - centerLh) * epFly;
      overlayAlpha = 1.0 - epFly;
      breathe = (1.0 - epFly) * 0.35;
      mergeBoost = (1.0 - epFly) * 0.25;
      state.mergePulseEl.style.opacity = "0";

      if (pFly >= 1.0) {
        finishAndUnmount();
        return;
      }
    }

    state.backdropEl.style.opacity = overlayAlpha.toFixed(3);

    var auraStrength = breathe * 0.55 + mergeBoost * 0.95;
    if (auraStrength > 0.02 && overlayAlpha > 0.05) {
      var aw = curLw * (0.95 + 0.16 * mergeBoost);
      var ah = curLh * (1.25 + 0.22 * mergeBoost);
      var glowCol = state.theme === "light" ? "rgba(2, 132, 199, " : "rgba(56, 189, 248, ";
      var glowAlpha = Math.min(0.55, (state.theme === "light" ? 0.18 : 0.28) * auraStrength) * overlayAlpha;
      state.auraEl.style.width = aw.toFixed(1) + "px";
      state.auraEl.style.height = ah.toFixed(1) + "px";
      state.auraEl.style.background = glowCol + glowAlpha.toFixed(3) + ")";
      state.auraEl.style.opacity = "1";
      state.auraEl.style.transform = "translate3d(" + (curLx - aw / 2).toFixed(1) + "px, " + (curLy - ah / 2).toFixed(1) + "px, 0)";
    } else {
      state.auraEl.style.opacity = "0";
    }

    state.logoWrapEl.style.width = curLw.toFixed(1) + "px";
    state.logoWrapEl.style.height = curLh.toFixed(1) + "px";
    state.logoWrapEl.style.transform = "translate3d(" + (curLx - curLw / 2).toFixed(1) + "px, " + (curLy - curLh / 2).toFixed(1) + "px, 0)";

    var brightnessVal = 0.95 + 0.14 * breathe + 0.18 * mergeBoost;
    var dropAlpha = (0.12 + 0.22 * breathe + 0.35 * mergeBoost) * overlayAlpha;
    if (state.phase === "flying" && overlayAlpha < 0.25) {
      state.logoWrapEl.style.filter = "none";
      state.logoWrapEl.style.opacity = "1";
    } else {
      var logoOpacity = state.phase === "looping" ? (0.88 + 0.12 * breathe) : 1.0;
      state.logoWrapEl.style.opacity = logoOpacity.toFixed(3);
      state.logoWrapEl.style.filter =
        "brightness(" + brightnessVal.toFixed(3) + ") drop-shadow(0 0 18px rgba(56, 189, 248, " + dropAlpha.toFixed(3) + "))";
    }

    scheduleNextTick();
  }

  function beginConvergence() {
    if (!state.active) {
      if (state.completeResolve) {
        var res0 = state.completeResolve;
        state.completeResolve = null;
        state.completePromise = null;
        res0();
      }
      return;
    }
    if (state.overlayEl) {
      state.overlayEl.style.pointerEvents = "none";
    }
    var nowMs = performance.now();
    var tSec = (nowMs - state.startTimeMs) / 1000;
    var metrics = computeLayoutMetrics();
    state.convergeStartStates = [];
    for (var i = 0; i < CLOUDS_TEMPLATE.length; i++) {
      state.convergeStartStates.push(getCloudPhase1Position(CLOUDS_TEMPLATE[i], tSec, metrics));
    }
    state.phase = "converging";
    state.phaseStartTimeMs = nowMs;
  }

  function finishAndUnmount() {
    if (state.rafId) {
      window.cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    if (state.fallbackTimerId) {
      clearTimeout(state.fallbackTimerId);
      state.fallbackTimerId = null;
    }
    if (state.pendingCompleteTimer) {
      clearTimeout(state.pendingCompleteTimer);
      state.pendingCompleteTimer = null;
    }
    restoreNavLogoVisibility();
    state.active = false;
    state.phase = "idle";
    if (state.overlayEl) {
      state.overlayEl.style.pointerEvents = "";
      state.overlayEl.classList.add("hidden");
      state.overlayEl.setAttribute("aria-hidden", "true");
    }
    if (state.completeResolve) {
      var resolveFn = state.completeResolve;
      state.completeResolve = null;
      state.completePromise = null;
      resolveFn();
    }
  }

  var lastClickOrigin = { x: null, y: null, timeMs: 0 };

  function recordInteractionOrigin(evt) {
    try {
      if (!evt) return;
      var target = evt.target && evt.target.closest
        ? evt.target.closest("button, [role='button'], [role='option'], input[type='checkbox'], .status-chip, .btn-xs, .btn-sm, .btn-accent") || evt.target
        : evt.target;
      if (target && typeof target.getBoundingClientRect === "function") {
        var r = target.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.width < 520 && r.height < 220) {
          lastClickOrigin.x = r.left + r.width / 2;
          lastClickOrigin.y = r.top + r.height / 2;
          lastClickOrigin.timeMs = performance.now();
          return;
        }
      }
      if (typeof evt.clientX === "number" && typeof evt.clientY === "number" && (evt.clientX > 0 || evt.clientY > 0)) {
        lastClickOrigin.x = evt.clientX;
        lastClickOrigin.y = evt.clientY;
        lastClickOrigin.timeMs = performance.now();
      }
    } catch (_) {}
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("pointerdown", recordInteractionOrigin, true);
    document.addEventListener("click", recordInteractionOrigin, true);
    document.addEventListener(
      "keydown",
      function (e) {
        if (e && (e.key === "Enter" || e.key === " ")) {
          recordInteractionOrigin(e);
        }
      },
      true
    );
  }

  function resolveBurstOrigin(opts, vw, vh) {
    if (opts && typeof opts.originX === "number" && typeof opts.originY === "number") {
      return { x: opts.originX, y: opts.originY };
    }
    var anchor = opts && (opts.anchorEl || opts.element || opts.target);
    if (typeof anchor === "string" && typeof document !== "undefined") {
      anchor = document.querySelector(anchor);
    }
    if (anchor) {
      if (typeof anchor.originX === "number" && typeof anchor.originY === "number") {
        return { x: anchor.originX, y: anchor.originY };
      }
      if (typeof anchor.x === "number" && typeof anchor.y === "number") {
        return { x: anchor.x, y: anchor.y };
      }
      if (typeof anchor.getBoundingClientRect === "function") {
        var rect = anchor.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
      }
    }
    if (
      typeof lastClickOrigin.x === "number" &&
      typeof lastClickOrigin.y === "number" &&
      performance.now() - lastClickOrigin.timeMs < 4000
    ) {
      return { x: lastClickOrigin.x, y: lastClickOrigin.y };
    }
    return { x: vw / 2, y: vh / 2 };
  }

  function ensureBurstLayerDom() {
    injectScopedStyles();
    var layer = document.querySelector("[data-gatheren-burst-layer]");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "gatheren-burst-layer";
      layer.setAttribute("data-gatheren-burst-layer", "1");
      layer.setAttribute("aria-hidden", "true");
      document.body.appendChild(layer);
    }
    return layer;
  }

  var GatherenLoader = {
    /**
     * Starts Phase 1 looping loading animation.
     * @param {Object} [options]
     * @param {string} [options.targetSelector=".top-navbar .brand-cluster"]
     * @param {string} [options.theme] - "dark" | "light" (auto-detected if omitted)
     * @param {string} [options.logoDarkSrc]
     * @param {string} [options.logoLightSrc]
     * @param {number} [options.minLoopDurationMs=0]
     * @param {number} [options.convergeDurationMs=320]
     * @param {number} [options.flyDurationMs=380]
     * @param {boolean} [options.forceFullDuration=false]
     */
    start: function (options) {
      var opts = options || {};
      var isAutomatedWebdriver = Boolean(
        navigator && navigator.webdriver && !root.__GATHEREN_TEST_LOADER_ANIMATION && !opts.forceFullDuration
      );

      if (state.pendingCompleteTimer) {
        clearTimeout(state.pendingCompleteTimer);
        state.pendingCompleteTimer = null;
      }
      if (state.rafId) {
        window.cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }
      if (state.fallbackTimerId) {
        clearTimeout(state.fallbackTimerId);
        state.fallbackTimerId = null;
      }
      restoreNavLogoVisibility();

      var overlay = ensureOverlayDom();
      state.targetSelector = opts.targetSelector || ".top-navbar .brand-cluster";
      state.logoSources = discoverLogoSources(opts);
      state.theme = detectActiveTheme(opts.theme);
      state.minLoopDurationMs =
        typeof opts.minLoopDurationMs === "number" ? opts.minLoopDurationMs : 0;
      state.convergeDurationMs =
        typeof opts.convergeDurationMs === "number" ? opts.convergeDurationMs : isAutomatedWebdriver ? 35 : 320;
      state.flyDurationMs =
        typeof opts.flyDurationMs === "number" ? opts.flyDurationMs : isAutomatedWebdriver ? 35 : 380;

      overlay.setAttribute("data-loader-theme", state.theme);
      overlay.style.pointerEvents = "all";
      state.logoImgEl.src = state.theme === "light" ? state.logoSources.light : state.logoSources.dark;
      state.backdropEl.style.opacity = "1";
      state.mergePulseEl.style.opacity = "0";

      overlay.classList.remove("hidden");
      overlay.setAttribute("aria-hidden", "false");

      state.active = true;
      state.phase = "looping";
      state.startTimeMs = performance.now();
      state.phaseStartTimeMs = state.startTimeMs;
      state.completePromise = null;
      state.completeResolve = null;

      renderFrame();
      return GatherenLoader;
    },

    /**
     * Triggers localized celebratory clouds flying outward around the clicked button
     * (e.g., when a task is created, a new comment is added, or a task is marked "done").
     * When options.includeTrophy is true, mixes flying clouds with Trophy emojis of
     * roughly the same visual size.
     * @param {Object} [options]
     * @param {boolean} [options.includeTrophy=false]
     * @param {Element|string|Object} [options.anchorEl] - Button element, selector, or {originX, originY}
     * @param {number} [options.originX]
     * @param {number} [options.originY]
     * @param {number} [options.radius] - Localized burst radius in px (default ~95-115px)
     * @param {number} [options.count]
     * @param {number} [options.durationMs]
     * @returns {Promise<void>}
     */
    burstClouds: function (options) {
      var opts = options || {};
      var includeTrophy = Boolean(opts.includeTrophy);
      var isAutomatedWebdriver = Boolean(
        navigator && navigator.webdriver && !root.__GATHEREN_TEST_LOADER_ANIMATION && !opts.forceFullDuration
      );
      var vw = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 1280);
      var vh = Math.max(240, window.innerHeight || document.documentElement.clientHeight || 720);
      var scaleFactor = Math.min(1.0, Math.max(0.75, Math.min(vw / 1440, vh / 860)));
      var origin = resolveBurstOrigin(opts, vw, vh);
      var originX = Math.max(24, Math.min(vw - 24, origin.x));
      var originY = Math.max(24, Math.min(vh - 24, origin.y));
      var totalCount = typeof opts.count === "number" ? opts.count : includeTrophy ? 12 : 10;
      var durationMs =
        typeof opts.durationMs === "number"
          ? opts.durationMs
          : isAutomatedWebdriver
          ? 60
          : includeTrophy
          ? 820
          : 680;

      var layer = ensureBurstLayerDom();
      var trophyChar = String.fromCodePoint(0x1f3c6);
      var trophyModulo = opts.fewTrophies ? 3 : 2;
      var maxRadius =
        typeof opts.radius === "number"
          ? opts.radius
          : Math.round((includeTrophy ? 112 : 94) * scaleFactor);
      var particles = [];

      for (var i = 0; i < totalCount; i++) {
        var isTrophy = includeTrophy && i % trophyModulo === 1;
        var baseAngle = (i / totalCount) * Math.PI * 2;
        var angleJitter = ((i % 3) - 1) * 0.12;
        var angle = baseAngle + angleJitter;
        var speedRatio = 0.64 + ((i * 7) % 5) * 0.1;
        var dist = maxRadius * speedRatio;
        var startRadius = (5 + (i % 3) * 4) * scaleFactor;
        var itemScale = (0.17 + ((i * 3) % 4) * 0.02) * scaleFactor;
        var w = isTrophy ? Math.round(92 * itemScale * 1.9) : Math.round(CLOUD_BASE_W * itemScale);
        var h = isTrophy ? w : Math.round(CLOUD_BASE_H * itemScale);

        var el;
        if (isTrophy) {
          el = document.createElement("div");
          el.className = "gatheren-burst-item gatheren-burst-trophy";
          el.textContent = trophyChar;
          el.style.width = w + "px";
          el.style.height = h + "px";
          el.style.fontSize = Math.round(w * 0.84) + "px";
        } else {
          el = document.createElement("img");
          el.className = "gatheren-burst-item gatheren-burst-cloud";
          el.src = CLOUD_SPRITE_DATA_URI;
          el.alt = "";
          el.style.width = w + "px";
          el.style.height = h + "px";
        }
        el.setAttribute("aria-hidden", "true");
        layer.appendChild(el);

        particles.push({
          el: el,
          isTrophy: isTrophy,
          w: w,
          h: h,
          sx: originX + Math.cos(angle) * startRadius,
          sy: originY + Math.sin(angle) * startRadius,
          tx: originX + Math.cos(angle) * dist,
          ty: originY + Math.sin(angle) * dist,
          arcLift: ((i % 2 === 0 ? -1 : 1) * (8 + (i % 3) * 4)) * scaleFactor,
          rotStart: isTrophy ? (i % 2 === 0 ? -10 : 10) : 0,
          rotEnd: isTrophy ? (i % 2 === 0 ? 15 : -15) : (i % 2 === 0 ? 7 : -7),
          stagger: (i % 4) * 0.035
        });
      }

      var startMs = performance.now();
      return new Promise(function (resolve) {
        var rafHandle = null;
        var timerHandle = null;
        var finished = false;

        function cleanupBurst() {
          if (finished) return;
          finished = true;
          if (rafHandle) window.cancelAnimationFrame(rafHandle);
          if (timerHandle) clearTimeout(timerHandle);
          for (var m = 0; m < particles.length; m++) {
            if (particles[m].el && particles[m].el.parentNode) {
              particles[m].el.parentNode.removeChild(particles[m].el);
            }
          }
          resolve();
        }

        function stepBurst() {
          if (finished) return;
          var elapsed = performance.now() - startMs;
          var rawP = Math.max(0, Math.min(1, elapsed / Math.max(1, durationMs)));

          for (var pIdx = 0; pIdx < particles.length; pIdx++) {
            var pt = particles[pIdx];
            var lp = Math.max(0, Math.min(1, (rawP - pt.stagger) / (1 - pt.stagger)));
            var easeOut = 1 - Math.pow(1 - lp, 3);
            var cx = pt.sx + (pt.tx - pt.sx) * easeOut;
            var cy = pt.sy + (pt.ty - pt.sy) * easeOut + Math.sin(lp * Math.PI) * pt.arcLift;
            var scalePop = lp < 0.15 ? 0.55 + (lp / 0.15) * 0.55 : 1.1 - (lp - 0.15) * 0.22;
            var opacity = lp < 0.12 ? lp / 0.12 : lp > 0.68 ? Math.max(0, (1 - lp) / 0.32) : 0.96;
            var rot = pt.rotStart + (pt.rotEnd - pt.rotStart) * easeOut;

            pt.el.style.opacity = opacity.toFixed(3);
            pt.el.style.transform =
              "translate3d(" +
              (cx - pt.w / 2).toFixed(1) +
              "px, " +
              (cy - pt.h / 2).toFixed(1) +
              "px, 0) scale(" +
              scalePop.toFixed(3) +
              ") rotate(" +
              rot.toFixed(1) +
              "deg)";
          }

          if (rawP >= 1.0) {
            cleanupBurst();
            return;
          }
          if (rafHandle) window.cancelAnimationFrame(rafHandle);
          if (timerHandle) clearTimeout(timerHandle);
          rafHandle = window.requestAnimationFrame(stepBurst);
          timerHandle = setTimeout(stepBurst, 32);
        }

        stepBurst();
      });
    },

    /**
     * Plays a synthesized congratulatory fanfare chime via Web Audio API.
     */
    playCelebrationSound: function () {
      try {
        var AudioCtx = root.AudioContext || root.webkitAudioContext;
        if (!AudioCtx) return;
        var ctx = new AudioCtx();
        if (ctx.state === "suspended" && typeof ctx.resume === "function") {
          ctx.resume().catch(function () {});
        }
        var now = ctx.currentTime;
        var notes = [
          { freq: 523.25, start: 0.0, dur: 0.22, gain: 0.11, type: "triangle" },
          { freq: 659.25, start: 0.09, dur: 0.24, gain: 0.12, type: "triangle" },
          { freq: 783.99, start: 0.18, dur: 0.28, gain: 0.13, type: "triangle" },
          { freq: 1046.5, start: 0.28, dur: 0.62, gain: 0.16, type: "triangle" },
          { freq: 1318.51, start: 0.34, dur: 0.56, gain: 0.09, type: "sine" },
          { freq: 1567.98, start: 0.4, dur: 0.65, gain: 0.1, type: "sine" }
        ];
        for (var i = 0; i < notes.length; i++) {
          var n = notes[i];
          var osc = ctx.createOscillator();
          var g = ctx.createGain();
          osc.type = n.type;
          osc.frequency.setValueAtTime(n.freq, now + n.start);
          g.gain.setValueAtTime(0.0001, now + n.start);
          g.gain.exponentialRampToValueAtTime(n.gain, now + n.start + 0.025);
          g.gain.exponentialRampToValueAtTime(0.0001, now + n.start + n.dur);
          osc.connect(g);
          g.connect(ctx.destination);
          osc.start(now + n.start);
          osc.stop(now + n.start + n.dur + 0.04);
        }
        setTimeout(function () {
          try {
            if (typeof ctx.close === "function") ctx.close();
          } catch (_) {}
        }, 1400);
      } catch (_) {}
    },

    /**
     * Shows the grand "Task completed" / "任務完成" popup (approx the size of the
     * central loading logo) with the cloud covering the bottom-left part of a big
     * Trophy emoji, plays a congratulatory sound effect, and launches Confetti + Trophy
     * emojis flying away from it.
     * @param {Object} [options]
     * @param {string} [options.lang] - "en" | "zh" (auto-detected if omitted)
     * @param {string} [options.text] - Explicit override text
     * @param {number} [options.durationMs=1550]
     * @param {boolean} [options.muteSound=false]
     * @returns {Promise<void>}
     */
    celebrateTaskCompletion: function (options) {
      var opts = options || {};
      var isAutomatedWebdriver = Boolean(
        navigator && navigator.webdriver && !root.__GATHEREN_TEST_LOADER_ANIMATION && !opts.forceFullDuration
      );
      var vw = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 1280);
      var vh = Math.max(240, window.innerHeight || document.documentElement.clientHeight || 720);
      var scaleFactor = Math.min(1.0, Math.max(0.52, Math.min(vw / 1600, vh / 920)));

      // Size matches the central logo on the initial loading animation (~600x300 scaled)
      var popupW = Math.round(600 * scaleFactor);
      var popupH = Math.round(300 * scaleFactor);
      var durationMs =
        typeof opts.durationMs === "number" ? opts.durationMs : isAutomatedWebdriver ? 70 : 1550;

      var activeLang =
        opts.lang ||
        (root.AppState && root.AppState.lang) ||
        (document.documentElement && document.documentElement.getAttribute("lang")) ||
        "zh";
      var isEn = String(activeLang).toLowerCase().indexOf("en") === 0;
      var labelText = opts.text || (isEn ? "Task completed" : "\u4efb\u52d9\u5b8c\u6210");

      if (!opts.muteSound && !isAutomatedWebdriver) {
        GatherenLoader.playCelebrationSound();
      }

      var layer = ensureBurstLayerDom();
      var trophyChar = String.fromCodePoint(0x1f3c6);
      var confettiChar = String.fromCodePoint(0x1f38a);

      // Build popup container (Cloud covering bottom-left of big Trophy)
      var popupEl = document.createElement("div");
      popupEl.className = "gatheren-task-complete-popup";
      popupEl.style.width = popupW + "px";
      popupEl.style.height = popupH + "px";

      var auraEl = document.createElement("div");
      auraEl.className = "gatheren-complete-aura";
      popupEl.appendChild(auraEl);

      // Big Trophy positioned in upper-right/center so its bottom-left is covered by the cloud
      var bigTrophyEl = document.createElement("div");
      bigTrophyEl.className = "gatheren-complete-big-trophy";
      var trophySize = Math.round(188 * scaleFactor);
      bigTrophyEl.style.width = trophySize + "px";
      bigTrophyEl.style.height = trophySize + "px";
      bigTrophyEl.style.fontSize = Math.round(168 * scaleFactor) + "px";
      bigTrophyEl.style.left = Math.round(popupW * 0.44) + "px";
      bigTrophyEl.style.top = Math.round(popupH * 0.02) + "px";
      bigTrophyEl.textContent = trophyChar;
      popupEl.appendChild(bigTrophyEl);

      // Cloud covering the bottom-left part of the big Trophy
      var cloudWrapEl = document.createElement("div");
      cloudWrapEl.className = "gatheren-complete-cloud-wrap";
      var cloudW = Math.round(372 * scaleFactor);
      var cloudH = Math.round(cloudW * (CLOUD_BASE_H / CLOUD_BASE_W));
      cloudWrapEl.style.width = cloudW + "px";
      cloudWrapEl.style.height = cloudH + "px";
      cloudWrapEl.style.left = Math.round(popupW * 0.07) + "px";
      cloudWrapEl.style.top = Math.round(popupH * 0.20) + "px";

      var cloudImgEl = document.createElement("img");
      cloudImgEl.className = "gatheren-complete-cloud-img";
      cloudImgEl.src = CLOUD_SPRITE_DATA_URI;
      cloudImgEl.alt = "";
      cloudWrapEl.appendChild(cloudImgEl);

      var textEl = document.createElement("div");
      textEl.className = "gatheren-complete-cloud-text";
      textEl.textContent = labelText;
      textEl.style.fontSize = Math.round((isEn ? 26 : 31) * scaleFactor) + "px";
      cloudWrapEl.appendChild(textEl);
      applyCompleteCloudSprite(cloudImgEl, textEl);

      popupEl.appendChild(cloudWrapEl);
      layer.appendChild(popupEl);

      // Spawn flying Confetti (0x1F38A) + Trophy (0x1F3C6) emojis radiating outward from the popup
      var cx0 = vw / 2;
      var cy0 = vh / 2;
      var particleCount = 18;
      var maxFlyRadius = Math.round(340 * scaleFactor);
      var particles = [];

      for (var i = 0; i < particleCount; i++) {
        var isConfetti = i % 2 === 0;
        var angle = (i / particleCount) * Math.PI * 2 + ((i % 3) - 1) * 0.1;
        var dist = maxFlyRadius * (0.68 + ((i * 5) % 5) * 0.1);
        var startR = (42 + (i % 4) * 16) * scaleFactor;
        var pSize = Math.round((42 + (i % 3) * 8) * scaleFactor);

        var pEl = document.createElement("div");
        pEl.className = "gatheren-burst-item gatheren-burst-trophy";
        pEl.textContent = isConfetti ? confettiChar : trophyChar;
        pEl.style.width = pSize + "px";
        pEl.style.height = pSize + "px";
        pEl.style.fontSize = Math.round(pSize * 0.86) + "px";
        pEl.setAttribute("aria-hidden", "true");
        layer.appendChild(pEl);

        particles.push({
          el: pEl,
          size: pSize,
          sx: cx0 + Math.cos(angle) * startR,
          sy: cy0 + Math.sin(angle) * startR,
          tx: cx0 + Math.cos(angle) * dist,
          ty: cy0 + Math.sin(angle) * dist,
          arcLift: ((i % 2 === 0 ? -1 : 1) * (18 + (i % 3) * 10)) * scaleFactor,
          rotStart: isConfetti ? -18 : 12,
          rotEnd: isConfetti ? 28 : -22,
          stagger: (i % 5) * 0.035
        });
      }

      var startMs = performance.now();
      return new Promise(function (resolve) {
        var rafHandle = null;
        var timerHandle = null;
        var finished = false;

        function cleanupCelebration() {
          if (finished) return;
          finished = true;
          if (rafHandle) window.cancelAnimationFrame(rafHandle);
          if (timerHandle) clearTimeout(timerHandle);
          if (popupEl && popupEl.parentNode) {
            popupEl.parentNode.removeChild(popupEl);
          }
          for (var m = 0; m < particles.length; m++) {
            if (particles[m].el && particles[m].el.parentNode) {
              particles[m].el.parentNode.removeChild(particles[m].el);
            }
          }
          resolve();
        }

        function stepCelebration() {
          if (finished) return;
          var elapsed = performance.now() - startMs;
          var rawP = Math.max(0, Math.min(1, elapsed / Math.max(1, durationMs)));

          // Popup spring entrance (0..0.22), hold with gentle float (0.22..0.78), smooth exit (0.78..1.0)
          var popScale = 1.0;
          var popOpacity = 1.0;
          var trophyTilt = 0.0;
          if (rawP < 0.22) {
            var epIn = rawP / 0.22;
            var backOut = 1 + 1.8 * Math.pow(epIn - 1, 3) + 0.8 * Math.pow(epIn - 1, 2);
            popScale = 0.42 + 0.58 * backOut;
            popOpacity = Math.min(1, epIn * 1.4);
            trophyTilt = Math.sin(epIn * Math.PI) * 8;
          } else if (rawP < 0.78) {
            var holdP = (rawP - 0.22) / 0.56;
            popScale = 1.0 + 0.025 * Math.sin(holdP * Math.PI * 2);
            popOpacity = 1.0;
            trophyTilt = Math.sin(holdP * Math.PI * 3) * 4;
          } else {
            var epOut = (rawP - 0.78) / 0.22;
            popScale = 1.0 + 0.08 * epOut;
            popOpacity = Math.max(0, 1 - epOut);
          }

          popupEl.style.opacity = popOpacity.toFixed(3);
          popupEl.style.transform =
            "translate3d(-50%, -50%, 0) scale(" + popScale.toFixed(3) + ")";
          bigTrophyEl.style.transform = "rotate(" + trophyTilt.toFixed(2) + "deg)";

          for (var pIdx = 0; pIdx < particles.length; pIdx++) {
            var pt = particles[pIdx];
            var lp = Math.max(0, Math.min(1, (rawP - pt.stagger) / (1 - pt.stagger)));
            var easeOut = 1 - Math.pow(1 - lp, 3);
            var px = pt.sx + (pt.tx - pt.sx) * easeOut;
            var py = pt.sy + (pt.ty - pt.sy) * easeOut + Math.sin(lp * Math.PI) * pt.arcLift;
            var pScale = lp < 0.16 ? 0.45 + (lp / 0.16) * 0.65 : 1.1 - (lp - 0.16) * 0.25;
            var pOp = lp < 0.12 ? lp / 0.12 : lp > 0.68 ? Math.max(0, (1 - lp) / 0.32) : 0.98;
            var pRot = pt.rotStart + (pt.rotEnd - pt.rotStart) * easeOut;

            pt.el.style.opacity = pOp.toFixed(3);
            pt.el.style.transform =
              "translate3d(" +
              (px - pt.size / 2).toFixed(1) +
              "px, " +
              (py - pt.size / 2).toFixed(1) +
              "px, 0) scale(" +
              pScale.toFixed(3) +
              ") rotate(" +
              pRot.toFixed(1) +
              "deg)";
          }

          if (rawP >= 1.0) {
            cleanupCelebration();
            return;
          }
          if (rafHandle) window.cancelAnimationFrame(rafHandle);
          if (timerHandle) clearTimeout(timerHandle);
          rafHandle = window.requestAnimationFrame(stepCelebration);
          timerHandle = setTimeout(stepCelebration, 32);
        }

        stepCelebration();
      });
    },

    /**
     * Triggers Phase 2 (Step 2A Cloud Convergence -> Step 2B Fly to Top-Left Header)
     * once minLoopDurationMs has elapsed, returning a Promise that resolves when done.
     * @returns {Promise<void>}
     */
    complete: function () {
      if (!state.active) {
        return Promise.resolve();
      }
      if (state.completePromise) {
        return state.completePromise;
      }
      state.completePromise = new Promise(function (resolve) {
        state.completeResolve = resolve;
        var elapsed = performance.now() - state.startTimeMs;
        var remaining = Math.max(0, state.minLoopDurationMs - elapsed);
        if (remaining <= 0) {
          beginConvergence();
        } else {
          state.pendingCompleteTimer = setTimeout(function () {
            state.pendingCompleteTimer = null;
            beginConvergence();
          }, remaining);
        }
      });
      return state.completePromise;
    },

    /**
     * Convenience wrapper: starts Phase 1, awaits asyncTaskFn(), then runs Phase 2.
     * @param {Function|Promise} asyncTaskOrPromise
     * @param {Object} [options]
     * @returns {Promise<*>}
     */
    runDuring: function (asyncTaskOrPromise, options) {
      GatherenLoader.start(options);
      var taskPromise;
      try {
        taskPromise = typeof asyncTaskOrPromise === "function" ? Promise.resolve(asyncTaskOrPromise()) : Promise.resolve(asyncTaskOrPromise);
      } catch (err) {
        GatherenLoader.hideImmediate();
        return Promise.reject(err);
      }
      return taskPromise.then(
        function (result) {
          return GatherenLoader.complete().then(function () {
            return result;
          });
        },
        function (err) {
          GatherenLoader.hideImmediate();
          throw err;
        }
      );
    },

    /**
     * Subtle, trophy-free result-ready animation: applies a specular cyan-emerald
     * glow sweep + gentle spring settle on the target container and optionally
     * emits a subtle cloud puff (strictly NO trophies and NO fanfare sound).
     * @param {Element|string} [targetElOrSelector]
     * @param {Object} [options]
     * @returns {Promise<void>}
     */
    pulseResultReady: function (targetElOrSelector, options) {
      injectScopedStyles();
      var opts = options || {};
      var targetEl = null;
      if (typeof targetElOrSelector === "string" && targetElOrSelector) {
        try {
          targetEl = document.querySelector(targetElOrSelector);
        } catch (_e) {}
      } else if (targetElOrSelector && typeof targetElOrSelector.getBoundingClientRect === "function") {
        targetEl = targetElOrSelector;
      }
      if (targetEl && targetEl.classList) {
        if (targetEl._gsPulseCleanupTimer) {
          clearTimeout(targetEl._gsPulseCleanupTimer);
        }
        targetEl.classList.remove("gs-result-ready-pulse");
        void targetEl.offsetWidth;
        targetEl.classList.add("gs-result-ready-pulse");
        targetEl._gsPulseCleanupTimer = setTimeout(function () {
          targetEl.classList.remove("gs-result-ready-pulse");
          targetEl._gsPulseCleanupTimer = null;
        }, 720);
      }
      if (opts.burst === false) {
        return Promise.resolve();
      }
      return GatherenLoader.burstClouds({
        includeTrophy: false,
        anchorEl: opts.anchorEl || targetEl || undefined,
        count: typeof opts.count === "number" ? opts.count : 6,
        radius: typeof opts.radius === "number" ? opts.radius : 68,
        durationMs: typeof opts.durationMs === "number" ? opts.durationMs : 560
      });
    },

    /**
     * Smooth 3D Studio camera entry / reset glide (520ms cubic ease-out).
     * Assumes studioThree.camera.position and studioThree.controls.target have just
     * been set to their target framed coordinates. On automated webdriver (unless
     * forced), keeps exact final coordinates synchronously for deterministic tests.
     * @param {Object} studioThree
     * @param {Object} [options]
     * @returns {Promise<void>}
     */
    glideStudioCamera: function (studioThree, options) {
      var opts = options || {};
      if (!studioThree || !studioThree.camera || !studioThree.controls || !studioThree.controls.target) {
        return Promise.resolve();
      }
      var isAutomatedWebdriver = Boolean(
        navigator && navigator.webdriver && !root.__GATHEREN_TEST_LOADER_ANIMATION && !opts.forceGlide
      );
      if (isAutomatedWebdriver) {
        return Promise.resolve();
      }
      if (typeof studioThree._gsCamGlideCancel === "function") {
        studioThree._gsCamGlideCancel();
      }
      var cam = studioThree.camera;
      var ctrl = studioThree.controls;
      var endX = Number(cam.position.x) || 0;
      var endY = Number(cam.position.y) || 0;
      var endZ = Number(cam.position.z) || 0;
      var tgtX = Number(ctrl.target.x) || 0;
      var tgtY = Number(ctrl.target.y) || 0;
      var tgtZ = Number(ctrl.target.z) || 0;
      var dx = endX - tgtX;
      var dy = endY - tgtY;
      var dz = endZ - tgtZ;
      var dist = Math.hypot(dx, dy, dz) || 12;
      var startX = tgtX + dx * 1.16;
      var startY = tgtY + dy * 1.16 + dist * 0.08;
      var startZ = tgtZ + dz * 1.16;
      var startTgtY = tgtY - dist * 0.025;
      var durationMs = typeof opts.durationMs === "number" ? Math.max(80, opts.durationMs) : 520;
      var startMs = performance.now();

      return new Promise(function (resolve) {
        var rafId = null;
        var cancelled = false;
        var domEl = studioThree.renderer && studioThree.renderer.domElement;

        function finishGlide(snapToEnd) {
          if (cancelled) return;
          cancelled = true;
          if (rafId) window.cancelAnimationFrame(rafId);
          if (domEl) {
            domEl.removeEventListener("pointerdown", onUserInteract);
            domEl.removeEventListener("wheel", onUserInteract);
            domEl.removeEventListener("touchstart", onUserInteract);
          }
          studioThree._gsCamGlideCancel = null;
          if (snapToEnd) {
            ctrl.target.set(tgtX, tgtY, tgtZ);
            cam.position.set(endX, endY, endZ);
            cam.lookAt(tgtX, tgtY, tgtZ);
            ctrl.update();
            cam.updateMatrixWorld(true);
            if (studioThree.renderer && studioThree.scene) {
              studioThree.renderer.render(studioThree.scene, cam);
            }
          }
          resolve();
        }

        function onUserInteract() {
          finishGlide(false);
        }

        if (domEl) {
          domEl.addEventListener("pointerdown", onUserInteract, { passive: true });
          domEl.addEventListener("wheel", onUserInteract, { passive: true });
          domEl.addEventListener("touchstart", onUserInteract, { passive: true });
        }
        studioThree._gsCamGlideCancel = function () {
          finishGlide(true);
        };

        function stepGlide() {
          if (cancelled) return;
          var elapsed = performance.now() - startMs;
          var t = Math.max(0, Math.min(1, elapsed / durationMs));
          var ease = 1 - Math.pow(1 - t, 3);
          var curTgtY = startTgtY + (tgtY - startTgtY) * ease;
          ctrl.target.set(tgtX, curTgtY, tgtZ);
          cam.position.set(
            startX + (endX - startX) * ease,
            startY + (endY - startY) * ease,
            startZ + (endZ - startZ) * ease
          );
          cam.lookAt(tgtX, curTgtY, tgtZ);
          ctrl.update();
          cam.updateMatrixWorld(true);
          if (studioThree.renderer && studioThree.scene) {
            studioThree.renderer.render(studioThree.scene, cam);
          }
          if (t >= 1) {
            finishGlide(true);
            return;
          }
          rafId = window.requestAnimationFrame(stepGlide);
        }

        stepGlide();
      });
    },

    /**
     * Immediately hides the loader overlay (e.g. on logout or auth lock).
     */
    hideImmediate: function () {
      finishAndUnmount();
    },

    /**
     * Returns current loader state for diagnostics/tests.
     */
    getState: function () {
      return {
        active: state.active,
        phase: state.phase,
        theme: state.theme
      };
    }
  };

  root.GatherenLoader = GatherenLoader;
  root.GatherenLoadingAnimation = GatherenLoader;
})(typeof window !== "undefined" ? window : this);
