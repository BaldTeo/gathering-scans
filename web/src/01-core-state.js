/**
 * GatheringScans Frontend Module 01 — Core State, Auth Helpers, Telemetry & API Client
 */
"use strict";


  const _i18nTr = typeof window.tr === "function" ? window.tr : null;
  const tr = (zh, en) =>
    _i18nTr ? _i18nTr(zh, en) : typeof window.tr === "function" && window.tr !== tr ? window.tr(zh, en) : zh;

  // Polyfill Object3D.removeFromParent if needed
  if (window.THREE && window.THREE.Object3D && !window.THREE.Object3D.prototype.removeFromParent) {
    window.THREE.Object3D.prototype.removeFromParent = function () {
      if (this.parent !== null) this.parent.remove(this);
      return this;
    };
  }

  // Resilient fetch wrapper for /stream/ 3D tile requests so transient 502/503/504/429 responses auto-retry transparently
  if (typeof window !== "undefined" && typeof window.fetch === "function" && !window.__gsStreamFetchWrapped) {
    window.__gsStreamFetchWrapped = true;
    const _origFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const urlStr = typeof input === "string" ? input : (input && input.url ? String(input.url) : "");
      const methodStr = (init && init.method) || (input && input.method) || "GET";
      if (String(methodStr).toUpperCase() === "GET" && urlStr.includes("/stream/")) {
        const delays = [0, 350, 900, 1800];
        let lastResp = null;
        for (let i = 0; i < delays.length; i++) {
          if (delays[i] > 0) {
            await new Promise((r) => setTimeout(r, delays[i]));
          }
          try {
            lastResp = await _origFetch(input, init);
          } catch (err) {
            if (i === delays.length - 1) throw err;
            continue;
          }
          if (
            !lastResp ||
            (lastResp.status !== 502 &&
              lastResp.status !== 503 &&
              lastResp.status !== 504 &&
              lastResp.status !== 429)
          ) {
            return lastResp;
          }
        }
        return lastResp;
      }
      return _origFetch(input, init);
    };
  }

  let sharedKtx2Loader = null;
  function getKTX2Loader(renderer) {
    if (!sharedKtx2Loader && window.THREE && window.THREE.KTX2Loader) {
      try {
        sharedKtx2Loader = new window.THREE.KTX2Loader();
        sharedKtx2Loader.setTranscoderPath("/lib/basis/");
        if (renderer) sharedKtx2Loader.detectSupport(renderer);
      } catch (e) {
        console.warn("[GatheringScans] KTX2Loader init warning:", e);
      }
    }
    return sharedKtx2Loader;
  }

  const DEFAULT_GOOGLE_MAPS_API_KEY =
    window.DEFAULT_GOOGLE_MAPS_API_KEY || localStorage.getItem("GC_GOOGLE_MAPS_API_KEY") || "";

  const GOOGLE_OAUTH_CLIENT_ID =
    window.GOOGLE_OAUTH_CLIENT_ID ||
    "753778992341-hpe65ilnti31j0m7etmq5rn7a1q802da.apps.googleusercontent.com";

  // Load persisted user profile only if explicitly authorized with a cryptographic session_token (or Guest mode)
  function getInitialCurrentUser() {
    try {
      const verified = localStorage.getItem("gs_auth_verified_v1") === "1";
      if (!verified) return null;
      const saved =
        localStorage.getItem("gathering_user_profile") ||
        localStorage.getItem("gs_current_user");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.email) {
          const isGuest = String(parsed.role || "").toLowerCase() === "guest" || String(parsed.email).startsWith("guest@");
          const hasToken = Boolean(parsed.session_token || parsed.sessionToken);
          if (!isGuest && !hasToken) {
            localStorage.removeItem("gs_auth_verified_v1");
            return null;
          }
          if (
            String(parsed.email).toLowerCase() === "glibivanov@gatheren.com.tw" &&
            (!parsed.name || parsed.name === "Glib Ivanov")
          ) {
            parsed.name = "雲在天";
          }
          return Object.assign({ offlineCacheEnabled: true }, parsed);
        }
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  const _urlParams = new URLSearchParams(window.location.search);
  const _embedBoot = (typeof window !== "undefined" && window.__GS_EMBED_BOOTSTRAP__) ? window.__GS_EMBED_BOOTSTRAP__ : null;
  const _pathEmbedMatch = String(window.location.pathname || "").match(/^\/embed\/([^/?#]+)/);
  const initialShareToken =
    (_embedBoot && _embedBoot.share_token ? String(_embedBoot.share_token) : "") ||
    _urlParams.get("share") ||
    (_pathEmbedMatch ? decodeURIComponent(_pathEmbedMatch[1]) : "");
  const _rawEmbedParam = String(
    _urlParams.get("embed") ||
    (_pathEmbedMatch ? "1" : "") ||
    (_embedBoot && _embedBoot.embed_mode ? _embedBoot.embed_mode : (_embedBoot && _embedBoot.embed ? "1" : ""))
  ).trim().toLowerCase();
  const initialEmbedMode =
    _rawEmbedParam === "poster"
      ? "poster"
      : (_rawEmbedParam === "1" || _rawEmbedParam === "true" || _rawEmbedParam === "yes" || _rawEmbedParam === "instant" ? "instant" : "");
  const initialIsEmbedded = Boolean(initialEmbedMode);
  if (initialIsEmbedded && typeof document !== "undefined" && document.documentElement) {
    document.documentElement.classList.add("gs-embed-mode");
    document.documentElement.setAttribute("data-theme", "light");
  }
  const initialUser = getInitialCurrentUser();

  // Application State
  const STATE = {
    activeView: initialIsEmbedded ? "studio" : "map",
    embedMode: initialEmbedMode,
    isEmbedded: initialIsEmbedded,
    embedPosterDismissed: initialEmbedMode !== "poster",
    scans: (_embedBoot && Array.isArray(_embedBoot.scans)) ? _embedBoot.scans : [],
    projects: (_embedBoot && Array.isArray(_embedBoot.projects)) ? _embedBoot.projects : [],
    materials: (_embedBoot && _embedBoot.materials) ? _embedBoot.materials : {},
    activeScanId: (_embedBoot && _embedBoot.initial_scan_id) ? String(_embedBoot.initial_scan_id) : (_urlParams.get("scan") || ""),
    activeScan: null,
    activeProjectGroup: "",
    projectFilterQuery: "",
    siteTimelineOpen: false,
    selectedTimelineScanId: "",
    capturedThumbs: new Set(),
    scanBrightness: 1.0,
    mapLyrs: "y", // 'y' = Google Satellite Hybrid, 'm' = Google Roadmap
    scanGoogleMapEnabled: true,
    scanGoogleMapLyrs: "y", // 'y' = Satellite, 'm' = Map (Roadmap)
    scanGoogleMapOpacity: 0.5,
    activeTool: "distance",
    snapEnabled: true,
    pcOnline: true,
    shareToken: initialShareToken,
    shareLinkInfo: (_embedBoot && _embedBoot.share_link) ? _embedBoot.share_link : null,
    currentUser: initialUser,
    isAuthorized: Boolean(initialUser && initialUser.email) || Boolean(initialShareToken) || Boolean(initialIsEmbedded),
    themePreference: initialIsEmbedded ? "light" : (localStorage.getItem("gs_theme_pref") || "auto"),
    resolvedTheme: "light",
    teamProfiles: [],
    cachedScanIds: new Set(JSON.parse(localStorage.getItem("gs_cached_scans") || "[]")),
    measurePoints: [],
    maskBoundaryPoints: [],
    cropMode: "delete_inside",
    lassoInputMethod: "lasso",
    lassoVisibleOnlyDelete: false,
    lassoVisibleOnlyKeep: false,
    lassoStrokes: [],
    pendingCropPolygons: [],
    cropPolygonPoints: [],
    lassoSelectedTriCount: 0,
    scanBackupStatus: null,
    stagedEdits: {
      scanId: "",
      rev: 0,
      deletions: [],
      cropKeep: null,
      compressionPreset: null,
      crsConfig: null,
      newScanName: "",
    },
    completedMeasurements: [],
    movingVertex: null,
    tempDistanceObjects: [],
    tempDistanceBadges: [],
    badges2D: [],
    volumeBadges2D: [],
    lastVolumeResult: null,
    lastContoursResult: null,
    lastProfileResult: null,
    categorizeLabelsVisible: true,
    categorizeEditMode: null,
    categorizeEditPoints: [],
    studioLassoOrbitMode: false,
    sidePanelMinimized: false,
    compareScanCount: 2,
    compareTool: "none",
    compareProfilePoints: [],
    mapOrthoOverlayEnabled: true,
    mapOrthoOpacity: 0.78,
    mapOrthoImageCache: {},
    lastGcpQaResult: null,
    lastDrainageResult: null,
    drainageDensityPerM2: 0.25,
    sectionBoxState: {
      active: false,
      centerX: 0,
      centerY: 0,
      centerZ: 0,
      halfX: 25,
      halfY: 15,
      halfZ: 25,
      yawRad: 0,
      hideHandles: false,
    },
    keepSectionBoxClip: true,
    gcpPickMode: false,
    pendingCommentDraftPt: null,
    targetAttachCommentId: null,
    multiAlign: {
      active: false,
      gizmoMode: "both", // 'both' | 'translate' | 'rotate'
      selectedScanId: null,
      refCenter: null,
      layers: [],
      lastMergedScan: null,
    },
    fpMode: {
      active: false,
      locomotion: "fly", // 'fly' | 'walk'
      pointerLocked: false,
      yaw: 0,
      pitch: 0,
      baseSpeed: 8.0, // m/s (0.5 - 60.0 via Mouse Wheel or HUD slider)
      eyeHeight: 1.68, // meters above surface in 'walk' mode
      currentEyeOffset: 1.68,
      velX: 0,
      velY: 0,
      velZ: 0,
      onGround: false,
      keys: Object.create(null),
      dragLooking: false,
      dragLastX: 0,
      dragLastY: 0,
      dragDist: 0,
      lastFrameTime: 0,
    },
    scanLodMode: (function () {
      const urlLod = String(_urlParams.get("lod") || "").trim().toLowerCase();
      if (initialIsEmbedded) {
        return urlLod === "rough" ? "rough" : "auto";
      }
      if (urlLod === "rough" || urlLod === "auto" || urlLod === "max") return urlLod;
      try {
        const saved = localStorage.getItem("gs_studio_lod_mode_v2");
        if (saved === "rough" || saved === "auto" || saved === "max") return saved;
      } catch (_e) {}
      return "auto";
    })(),
    previewLodMode: (function () {
      try {
        const saved = localStorage.getItem("gs_preview_lod_mode_v2");
        if (saved === "rough" || saved === "auto" || saved === "max") return saved;
      } catch (_e) {}
      return "rough";
    })(),
    autoRotateEnabled: (function () {
      const urlRot = String(_urlParams.get("autorotate") || _urlParams.get("rotate") || "").trim().toLowerCase();
      if (urlRot === "0" || urlRot === "false" || urlRot === "off") return false;
      if (urlRot === "1" || urlRot === "true" || urlRot === "on") return true;
      return true;
    })(),
    autoRotateSpeed: 0.45,
  };
  window.STATE = STATE;

  function isIPhoneOrMobilePhone() {
    if (typeof navigator !== "undefined" && /iPhone|iPod|Android.*Mobile/i.test(String(navigator.userAgent || ""))) return true;
    const isEmbedFrame = typeof window !== "undefined" && window.self !== window.top;
    if (typeof window !== "undefined" && !isEmbedFrame && window.innerWidth <= 767 && Number(navigator?.maxTouchPoints || 0) > 0) return true;
    return false;
  }
  window.isIPhoneOrMobilePhone = isIPhoneOrMobilePhone;

  function isIOSOrIPadDevice() {
    if (typeof navigator === "undefined") return false;
    const ua = String(navigator.userAgent || "");
    if (/iPad|iPhone|iPod/i.test(ua)) return true;
    const maxTouch = Number(navigator.maxTouchPoints || 0);
    if (maxTouch > 1 && (/Macintosh|Mac OS X/i.test(ua) || navigator.platform === "MacIntel")) {
      return true;
    }
    return false;
  }
  window.isIOSOrIPadDevice = isIOSOrIPadDevice;

  function isMobileOrTabletDevice() {
    if (isIOSOrIPadDevice()) return true;
    if (typeof navigator !== "undefined" && /Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(String(navigator.userAgent || ""))) {
      return true;
    }
    if (typeof window !== "undefined" && window.innerWidth <= 1024 && Number(navigator?.maxTouchPoints || 0) > 0) {
      return true;
    }
    return false;
  }
  window.isMobileOrTabletDevice = isMobileOrTabletDevice;

  function disposeObject3DResources(rootObj) {
    if (!rootObj || typeof rootObj.traverse !== "function") return;
    const texProps = [
      "map",
      "lightMap",
      "bumpMap",
      "normalMap",
      "specularMap",
      "envMap",
      "alphaMap",
      "aoMap",
      "displacementMap",
      "emissiveMap",
      "gradientMap",
      "metalnessMap",
      "roughnessMap",
    ];
    try {
      rootObj.traverse((node) => {
        if (!node) return;
        if (node.geometry && typeof node.geometry.dispose === "function") {
          try {
            node.geometry.dispose();
          } catch (_) {}
        }
        if (node.material) {
          const mats = Array.isArray(node.material) ? node.material : [node.material];
          mats.forEach((m) => {
            if (!m) return;
            texProps.forEach((tp) => {
              if (m[tp] && typeof m[tp].dispose === "function") {
                try {
                  m[tp].dispose();
                } catch (_) {}
              }
            });
            if (typeof m.dispose === "function") {
              try {
                m.dispose();
              } catch (_) {}
            }
          });
        }
      });
    } catch (_) {}
  }
  window.disposeObject3DResources = disposeObject3DResources;

  function resolveThemeFromPreference(pref) {
    const p = String(pref || "auto").toLowerCase();
    if (p === "light" || p === "dark") return p;
    const hr = new Date().getHours();
    return hr >= 6 && hr < 18 ? "light" : "dark";
  }

  function preprocessTileStreamUrl(uri, rootStreamUrl) {
    let u = uri;
    try {
      if (rootStreamUrl && rootStreamUrl.includes("?")) {
        const vParam = new URL(rootStreamUrl, window.location.origin).searchParams.get("v");
        if (vParam && !/[?&]v=/.test(u)) {
          u += (u.includes("?") ? "&" : "?") + `v=${encodeURIComponent(vParam)}`;
        }
      }
    } catch (_) {}
    if (STATE.shareToken && !u.includes("share=")) {
      u += (u.includes("?") ? "&" : "?") + `share=${encodeURIComponent(STATE.shareToken)}`;
    }
    return u;
  }

  // Apply initial theme attribute & authorization lock immediately to avoid flash
  STATE.resolvedTheme = resolveThemeFromPreference(STATE.themePreference);
  document.documentElement.setAttribute("data-theme", STATE.resolvedTheme);
  document.documentElement.setAttribute("data-theme-pref", STATE.themePreference);
  if (!STATE.isAuthorized && document.body) {
    document.body.classList.add("gs-auth-locked");
  }

  // Aggregate unique project groups dynamically (scales cleanly to 100+ projects)
  function getProjectGroupsList(filterQuery = "") {
    const q = String(filterQuery || "").trim().toLowerCase();
    const map = new Map();
    const isGeorefScan = (sc) =>
      sc &&
      sc.lat !== null &&
      sc.lat !== undefined &&
      sc.lon !== null &&
      sc.lon !== undefined &&
      Number.isFinite(Number(sc.lat)) &&
      Number.isFinite(Number(sc.lon)) &&
      (Math.abs(Number(sc.lat)) > 0.001 || Math.abs(Number(sc.lon)) > 0.001) &&
      !String(sc.crs || "").toUpperCase().includes("LOCAL");

    STATE.scans.forEach((s) => {
      const g = s.project_group || "Unassigned Site";
      if (!map.has(g)) {
        map.set(g, {
          project_group: g,
          project_name_zh: s.project_name_zh || "",
          lat: null,
          lon: null,
          hasGeoref: false,
          _latSum: 0,
          _lonSum: 0,
          _geoCount: 0,
          scans: [],
        });
      }
      const entry = map.get(g);
      if (!entry.project_name_zh && s.project_name_zh) {
        entry.project_name_zh = s.project_name_zh;
      }
      if (isGeorefScan(s)) {
        entry._latSum += Number(s.lat);
        entry._lonSum += Number(s.lon);
        entry._geoCount += 1;
      }
      entry.scans.push(s);
    });
    map.forEach((entry) => {
      if (entry._geoCount > 0) {
        entry.lat = entry._latSum / entry._geoCount;
        entry.lon = entry._lonSum / entry._geoCount;
        entry.hasGeoref = true;
      }
    });
    let list = Array.from(map.values()).sort(
      (a, b) => b.scans.length - a.scans.length || a.project_group.localeCompare(b.project_group)
    );
    if (q) {
      list = list.filter((grp) => {
        if (grp.project_group.toLowerCase().includes(q)) return true;
        if ((grp.project_name_zh || "").toLowerCase().includes(q)) return true;
        return grp.scans.some(
          (s) =>
            (s.name || "").toLowerCase().includes(q) ||
            (s.scan_id || "").toLowerCase().includes(q) ||
            (s.capture_date || "").toLowerCase().includes(q)
        );
      });
    }
    return list;
  }

  // Populate all project & scan selectors across Map, Timeline, Studio, and Compare (Supports 100+ Projects)
  function populateProjectScanDropdowns(projectGroup, preferredScanId = null) {
    const allGroups = getProjectGroupsList("");
    if (projectGroup === "__all__") {
      STATE.activeProjectGroup = "__all__";
    } else if (projectGroup && allGroups.some((g) => g.project_group === projectGroup)) {
      STATE.activeProjectGroup = projectGroup;
    } else if (STATE.activeScan && STATE.activeScan.project_group && STATE.activeProjectGroup !== "__all__") {
      STATE.activeProjectGroup = STATE.activeScan.project_group;
    } else if (!STATE.activeProjectGroup && allGroups.length > 0) {
      STATE.activeProjectGroup = allGroups[0].project_group;
    }

    // 1. Populate Map Project Selector (#mapProjectSelect) with search filter support
    const mapProjSel = document.getElementById("mapProjectSelect");
    if (mapProjSel) {
      const filteredGroups = getProjectGroupsList(STATE.projectFilterQuery);
      const prevMapVal = mapProjSel.value;
      mapProjSel.innerHTML = "";
      const allOpt = document.createElement("option");
      allOpt.value = "__all__";
      allOpt.textContent = STATE.projectFilterQuery
        ? tr("篩選工區", "Filtered Projects")
        : tr("全部工區", "All Projects");
      mapProjSel.appendChild(allOpt);

      filteredGroups.forEach((grp) => {
        const opt = document.createElement("option");
        opt.value = grp.project_group;
        opt.textContent = grp.project_group;
        mapProjSel.appendChild(opt);
      });

      if (STATE.activeProjectGroup === "__all__") {
        mapProjSel.value = "__all__";
      } else if (STATE.activeProjectGroup && filteredGroups.some((g) => g.project_group === STATE.activeProjectGroup)) {
        mapProjSel.value = STATE.activeProjectGroup;
      } else if (prevMapVal && Array.from(mapProjSel.options).some((o) => o.value === prevMapVal)) {
        mapProjSel.value = prevMapVal;
      } else {
        mapProjSel.value = "__all__";
      }
    }

    // 2. Populate Timeline, Studio, and Compare Project Switcher Dropdowns
    ["timelineProjectSelect", "studioProjectSelect", "compareProjectSelect"].forEach((selId) => {
      const sel = document.getElementById(selId);
      if (!sel) return;
      sel.innerHTML = "";
      if (selId === "timelineProjectSelect") {
        const allOpt = document.createElement("option");
        allOpt.value = "__all__";
        allOpt.textContent = tr("全部工區", "All Projects");
        sel.appendChild(allOpt);
      }
      allGroups.forEach((grp) => {
        const opt = document.createElement("option");
        opt.value = grp.project_group;
        opt.textContent = grp.project_group;
        sel.appendChild(opt);
      });
      if (selId === "timelineProjectSelect" && STATE.activeProjectGroup === "__all__") {
        sel.value = "__all__";
      } else if (STATE.activeProjectGroup && allGroups.some((g) => g.project_group === STATE.activeProjectGroup)) {
        sel.value = STATE.activeProjectGroup;
      } else if (allGroups[0]) {
        sel.value = allGroups[0].project_group;
      }
    });

    const resolvedSpecificGroup =
      STATE.activeProjectGroup && STATE.activeProjectGroup !== "__all__"
        ? STATE.activeProjectGroup
        : STATE.activeScan?.project_group || allGroups[0]?.project_group || "";

    // Update hidden badges for backward compatibility
    const studioBadge = document.getElementById("studioProjectGroupBadge");
    if (studioBadge) studioBadge.textContent = resolvedSpecificGroup;
    const cmpBadge = document.getElementById("compareProjectGroupBadge");
    if (cmpBadge) cmpBadge.textContent = resolvedSpecificGroup;

    // 3. Populate Scan Selectors strictly for the active project (or resolved project when __all__ is selected on map)
    let projectScans = STATE.scans.filter((s) => s.project_group === resolvedSpecificGroup);
    if (!projectScans.length) {
      projectScans = STATE.scans.slice();
    }

    const studioSel = document.getElementById("studioScanSelect");
    const cmpLeft = document.getElementById("compareLeftSelect");
    const cmpRight = document.getElementById("compareRightSelect");
    const cmpThird = document.getElementById("compareThirdSelect");
    const cmpFourth = document.getElementById("compareFourthSelect");

    [studioSel, cmpLeft, cmpRight, cmpThird, cmpFourth].forEach((sel, idx) => {
      if (!sel) return;
      const prevVal = sel.value;
      sel.innerHTML = "";
      projectScans.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.scan_id;
        opt.textContent = s.name;
        sel.appendChild(opt);
      });
      if (idx === 0 && preferredScanId && projectScans.some((s) => s.scan_id === preferredScanId)) {
        sel.value = preferredScanId;
      } else if (prevVal && projectScans.some((s) => s.scan_id === prevVal)) {
        sel.value = prevVal;
      } else if (projectScans.length > 0) {
        const defaultIdx = idx === 0 ? 0 : Math.min(idx - 1, projectScans.length - 1);
        sel.value = projectScans[defaultIdx].scan_id;
      }
    });

    if (cmpLeft && cmpRight && projectScans.length >= 2 && cmpLeft.value === cmpRight.value) {
      cmpLeft.value = projectScans[1].scan_id;
      cmpRight.value = projectScans[0].scan_id;
    }
    if (cmpThird && projectScans.length >= 3 && (cmpThird.value === cmpLeft?.value || cmpThird.value === cmpRight?.value)) {
      cmpThird.value = projectScans[2].scan_id;
    }
    if (cmpFourth && projectScans.length >= 4 && (cmpFourth.value === cmpLeft?.value || cmpFourth.value === cmpRight?.value || cmpFourth.value === cmpThird?.value)) {
      cmpFourth.value = projectScans[3].scan_id;
    }
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function syncMobileToastPosition() {
    const el = document.getElementById("gsToast");
    if (!el) return;
    if (window.innerWidth <= 768) {
      const panel = document.getElementById("studioSidePanel");
      const panelExpanded = Boolean(
        panel &&
          (panel.classList.contains("active") || panel.classList.contains("open")) &&
          !panel.classList.contains("hidden") &&
          !panel.classList.contains("mobile-minimized") &&
          !panel.classList.contains("gs-panel-minimized")
      );
      const fpActive = Boolean(STATE?.fpMode?.active);
      if (panelExpanded || fpActive) {
        el.style.setProperty("bottom", "auto", "important");
        el.style.setProperty("top", "192px", "important");
      } else {
        el.style.setProperty("top", "auto", "important");
        el.style.setProperty("bottom", "142px", "important");
      }
    } else {
      el.style.removeProperty("top");
      el.style.removeProperty("bottom");
    }
  }

  function showToast(msg, durationMs = 3400) {
    const el = document.getElementById("gsToast");
    if (!el) return;
    syncMobileToastPosition();
    const translatedMsg =
      typeof window.translateDynamicText === "function" ? window.translateDynamicText(String(msg || "")) : String(msg || "");
    el.textContent = translatedMsg;
    el.style.display = "block";
    el.classList.add("show");
    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
      el.classList.remove("show");
      el.style.display = "none";
    }, durationMs);
  }

  const SHARE_TELEMETRY = (() => {
    const enabled = Boolean(STATE.shareToken);
    const randHex = (len = 12) => {
      try {
        const arr = new Uint8Array(Math.ceil(len / 2));
        window.crypto.getRandomValues(arr);
        return Array.from(arr, (b) => b.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, len);
      } catch (_) {
        return Math.random().toString(36).slice(2, 2 + len);
      }
    };
    let visitorId = "";
    try {
      visitorId = localStorage.getItem("gs_visitor_uid_v1") || "";
      if (!visitorId) {
        visitorId = `v_${Date.now().toString(36)}_${randHex(10)}`;
        localStorage.setItem("gs_visitor_uid_v1", visitorId);
      }
    } catch (_) {
      visitorId = `v_mem_${randHex(10)}`;
    }
    const sessionId = `s_${Date.now().toString(36)}_${randHex(8)}`;
    const openPerfMs = performance.now();
    const openWallMs = Date.now();
    let lastInteractionMs = openPerfMs;
    let totalDurationSec = 0;
    let activeDurationSec = 0;
    let fpSeconds = 0;
    let maxLoadPct = 0;
    let loadTimeMs = 0;
    let cameraInteractions = 0;
    let commentsPosted = 0;
    let downloadsCount = 0;
    let measurementsCount = 0;
    let currentTool = "orbit";
    let gpuRenderer = "";
    let flushTimer = null;
    let eventSeq = 0;
    const scansMap = new Map();
    const toolsUsed = Object.create(null);
    const eventsLog = [];

    const detectGpuRenderer = () => {
      if (gpuRenderer) return gpuRenderer;
      try {
        const c = document.createElement("canvas");
        c.width = 1;
        c.height = 1;
        const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
        if (gl) {
          const dbg = gl.getExtension("WEBGL_debug_renderer_info");
          gpuRenderer = dbg
            ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "")
            : String(gl.getParameter(gl.RENDERER) || "");
          try {
            gl.getExtension("WEBGL_lose_context")?.loseContext();
          } catch (_) {}
        }
      } catch (_) {}
      return gpuRenderer;
    };

    const getConnectionSummary = () => {
      try {
        const nc = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!nc) return "";
        const parts = [];
        if (nc.effectiveType) parts.push(String(nc.effectiveType).toUpperCase());
        if (Number(nc.downlink) > 0) parts.push(`${Number(nc.downlink).toFixed(1)} Mbps`);
        return parts.join(" · ");
      } catch (_) {
        return "";
      }
    };

    const getViewerName = () => {
      try {
        const savedGuest = (localStorage.getItem("gs_guest_comment_author") || "").trim();
        if (savedGuest) return savedGuest;
      } catch (_) {}
      const uName = String(STATE.currentUser?.name || "").trim();
      if (uName && !["guest", "guest viewer", "anonymous"].includes(uName.toLowerCase())) {
        return uName;
      }
      return "";
    };

    const getViewerEmail = () => {
      const em = String(STATE.currentUser?.email || "").trim();
      if (em && !em.startsWith("guest@")) return em;
      return "";
    };

    const bumpTool = (toolKey, addCount = 1, addSec = 0) => {
      if (!enabled || !toolKey) return;
      const k = String(toolKey).replace(/[^a-zA-Z0-9_\-]/g, "").slice(0, 48);
      if (!k) return;
      if (!toolsUsed[k]) {
        toolsUsed[k] = { count: 0, seconds: 0 };
      }
      toolsUsed[k].count += addCount;
      toolsUsed[k].seconds = Math.round((toolsUsed[k].seconds + addSec) * 10) / 10;
    };

    const pushEvent = (type, detail) => {
      if (!enabled) return;
      eventSeq += 1;
      const tSec = Math.round(((performance.now() - openPerfMs) / 1000) * 10) / 10;
      eventsLog.push({
        id: `${sessionId}_${eventSeq}`,
        t: tSec,
        type: String(type || "event").slice(0, 40),
        detail: String(detail || "").slice(0, 180),
      });
      if (eventsLog.length > 90) eventsLog.shift();
    };

    const buildPayload = () => {
      totalDurationSec = Math.max(totalDurationSec, Math.round(((Date.now() - openWallMs) / 1000) * 10) / 10);
      const dpr = Number(window.devicePixelRatio || 1);
      const scr = window.screen
        ? `${window.screen.width}x${window.screen.height}${dpr > 1 ? ` @${dpr.toFixed(dpr % 1 ? 1 : 0)}x` : ""}`
        : "";
      const vp = `${window.innerWidth || 0}x${window.innerHeight || 0}`;
      let tz = "";
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      } catch (_) {}
      const isIpadDesktopMode =
        typeof navigator !== "undefined" &&
        Number(navigator.maxTouchPoints || 0) > 1 &&
        (/Macintosh|Mac OS X/i.test(String(navigator.userAgent || "")) || navigator.platform === "MacIntel");
      return {
        token: STATE.shareToken,
        session_id: sessionId,
        visitor_id: visitorId,
        viewer_name: getViewerName(),
        viewer_email: getViewerEmail(),
        ...(isIpadDesktopMode ? { device_type: "Tablet", os: "iPadOS" } : {}),
        language: navigator.language || "",
        timezone: tz,
        screen_res: scr,
        viewport_res: vp,
        gpu_renderer: detectGpuRenderer(),
        connection_type: getConnectionSummary(),
        referrer: document.referrer || "",
        entry_url: window.location.pathname + window.location.search,
        total_duration_sec: totalDurationSec,
        active_duration_sec: Math.round(activeDurationSec * 10) / 10,
        max_load_pct: Math.round(maxLoadPct * 10) / 10,
        load_time_ms: loadTimeMs,
        camera_interactions: cameraInteractions,
        fp_seconds: Math.round(fpSeconds * 10) / 10,
        comments_posted: commentsPosted,
        downloads_count: downloadsCount,
        measurements_count: measurementsCount,
        scans_viewed: Array.from(scansMap.values()),
        tools_used: toolsUsed,
        events: eventsLog.slice(-80),
      };
    };

    const flushNow = (useBeacon = false) => {
      if (!enabled || !STATE.shareToken) return;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      const payload = buildPayload();
      const url = `/api/share/telemetry?share=${encodeURIComponent(STATE.shareToken)}`;
      const jsonStr = JSON.stringify(payload);
      if (useBeacon && navigator.sendBeacon) {
        try {
          const blob = new Blob([jsonStr], { type: "application/json" });
          if (navigator.sendBeacon(url, blob)) return;
        } catch (_) {}
      }
      try {
        fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Share-Token": STATE.shareToken,
            "X-Telemetry-Session": sessionId,
          },
          body: jsonStr,
          keepalive: Boolean(useBeacon),
        }).catch(() => {});
      } catch (_) {}
    };

    const scheduleFlush = (delayMs = 500) => {
      if (!enabled) return;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => flushNow(false), delayMs);
    };

    if (enabled) {
      pushEvent("session_open", "Opened shared 3D scan link");
      bumpTool("orbit", 1, 0);
      const markActive = () => {
        lastInteractionMs = performance.now();
      };
      ["pointerdown", "pointermove", "wheel", "keydown", "touchstart"].forEach((evName) => {
        window.addEventListener(evName, markActive, { passive: true });
      });

      // 1-second active engagement + per-tool duration ticker
      setInterval(() => {
        const nowP = performance.now();
        totalDurationSec = Math.round(((Date.now() - openWallMs) / 1000) * 10) / 10;
        const recentlyEngaged = nowP - lastInteractionMs < 45000;
        if (document.visibilityState === "visible" && (recentlyEngaged || STATE.fpMode?.active)) {
          activeDurationSec += 1;
          if (STATE.fpMode?.active) {
            fpSeconds += 1;
            const fpKey = STATE.fpMode.locomotion === "walk" ? "first_person_walk" : "first_person_fly";
            bumpTool(fpKey, 0, 1);
          } else if (currentTool) {
            bumpTool(currentTool, 0, 1);
          }
        }
      }, 1000);

      // 10-second live heartbeat while visible
      setInterval(() => {
        if (document.visibilityState === "visible") {
          flushNow(false);
        }
      }, 10000);

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          flushNow(true);
        } else {
          lastInteractionMs = performance.now();
          scheduleFlush(1200);
        }
      });
      window.addEventListener("pagehide", () => flushNow(true));
      window.addEventListener("beforeunload", () => flushNow(true));
      setTimeout(() => flushNow(false), 1200);
    }

    return {
      enabled,
      sessionId,
      visitorId,
      flushNow,
      scheduleFlush,
      setViewerName(name) {
        if (!enabled) return;
        const clean = String(name || "").trim();
        if (clean) {
          try {
            localStorage.setItem("gs_guest_comment_author", clean);
          } catch (_) {}
          pushEvent("identity", `Viewer name set: ${clean}`);
          scheduleFlush(400);
        }
      },
      recordScanViewed(scan, viewCtx = "studio") {
        if (!enabled || !scan || !scan.scan_id) return;
        const isNew = !scansMap.has(scan.scan_id);
        scansMap.set(scan.scan_id, {
          scan_id: scan.scan_id,
          name: scan.name || scan.scan_id,
        });
        if (isNew) {
          pushEvent("scan_open", `Viewed ${scan.name || scan.scan_id} (${viewCtx})`);
          scheduleFlush(600);
        }
      },
      recordLoadProgress(pct, isFinished = false, loadElapsedMs = 0) {
        if (!enabled) return;
        const p = Math.max(0, Math.min(100, Number(pct || 0)));
        if (p > maxLoadPct) maxLoadPct = p;
        if (isFinished && loadTimeMs === 0) {
          loadTimeMs = Math.max(100, Math.round(loadElapsedMs || performance.now() - openPerfMs));
          maxLoadPct = 100;
          pushEvent("scan_loaded", `3D scan loaded 100% in ${(loadTimeMs / 1000).toFixed(1)}s`);
          scheduleFlush(500);
        }
      },
      recordCameraInteraction(viewCtx = "studio") {
        if (!enabled) return;
        lastInteractionMs = performance.now();
        cameraInteractions += 1;
        bumpTool("orbit", 1, 0);
        if (cameraInteractions === 1) {
          pushEvent("camera", `3D camera orbit/zoom (${viewCtx})`);
        }
      },
      recordToolSelected(toolName) {
        if (!enabled || !toolName) return;
        lastInteractionMs = performance.now();
        const prev = currentTool;
        currentTool = String(toolName);
        bumpTool(currentTool, 1, 0);
        if (prev !== currentTool) {
          pushEvent("tool", `Selected tool: ${currentTool}`);
          scheduleFlush(800);
        }
      },
      recordFirstPersonToggle(active, locomotion = "fly") {
        if (!enabled) return;
        lastInteractionMs = performance.now();
        if (active) {
          const fpKey = locomotion === "walk" ? "first_person_walk" : "first_person_fly";
          bumpTool(fpKey, 1, 0);
          pushEvent("first_person", `Entered First-Person (${locomotion})`);
        } else {
          pushEvent("first_person", "Exited First-Person mode");
        }
        scheduleFlush(600);
      },
      recordMeasurement(summaryText) {
        if (!enabled) return;
        lastInteractionMs = performance.now();
        measurementsCount += 1;
        bumpTool(currentTool || "measurement", 1, 0);
        const cleanTxt = String(summaryText || "").replace(/\s+/g, " ").trim().slice(0, 110);
        pushEvent("measurement", `${currentTool || "measure"}: ${cleanTxt || "completed"}`);
        scheduleFlush(600);
      },
      recordCommentPosted(authorName, text) {
        if (!enabled) return;
        lastInteractionMs = performance.now();
        commentsPosted += 1;
        bumpTool("comment_posted", 1, 0);
        const snippet = String(text || "").replace(/\s+/g, " ").trim().slice(0, 80);
        pushEvent("comment", `${authorName || "Reviewer"} posted comment: "${snippet}"`);
        flushNow(false);
      },
      recordDownload(ext, scan) {
        if (!enabled) return;
        lastInteractionMs = performance.now();
        downloadsCount += 1;
        const cleanExt = String(ext || "file").replace(".", "").toLowerCase();
        bumpTool(`download_${cleanExt}`, 1, 0);
        pushEvent("download", `Downloaded .${cleanExt} (${scan?.name || scan?.scan_id || "scan"})`);
        flushNow(true);
      },
      recordViewSwitch(viewName) {
        if (!enabled || !viewName) return;
        if (viewName === "compare") {
          bumpTool("compare_slider", 1, 0);
        }
        pushEvent("view", `Switched view: ${viewName}`);
      },
    };
  })();

  function apiHeaders(extra = {}) {
    const h = Object.assign({ "Content-Type": "application/json" }, extra);
    if (STATE.shareToken) {
      h["X-Share-Token"] = STATE.shareToken;
      if (SHARE_TELEMETRY.sessionId) {
        h["X-Telemetry-Session"] = SHARE_TELEMETRY.sessionId;
      }
    }
    if (STATE.currentUser && STATE.currentUser.email) {
      h["X-User-Email"] = STATE.currentUser.email;
    }
    const sessTok = STATE.currentUser?.session_token || STATE.currentUser?.sessionToken || "";
    if (sessTok) {
      h["X-Session-Token"] = sessTok;
    }
    return h;
  }

  function syncSessionTokenCookie(userObj = STATE.currentUser) {
    try {
      const sessTok = userObj?.session_token || userObj?.sessionToken || "";
      if (sessTok) {
        document.cookie = `gs_session_token=${encodeURIComponent(sessTok)}; path=/; max-age=2592000; SameSite=Lax`;
      } else {
        document.cookie = "gs_session_token=; path=/; max-age=0; SameSite=Lax";
      }
    } catch (e) {}
  }

  function appendAuthToDownloadUrl(rawUrl) {
    if (!rawUrl || rawUrl === "#") return rawUrl || "#";
    const u = String(rawUrl);
    if (u.startsWith("blob:") || u.startsWith("data:")) return u;
    try {
      const parsed = new URL(u, window.location.origin);
      const sessTok = STATE.currentUser?.session_token || STATE.currentUser?.sessionToken || "";
      if (sessTok && !STATE.shareToken) {
        parsed.searchParams.set("session_token", sessTok);
      } else if (STATE.shareToken && !parsed.searchParams.get("share")) {
        parsed.searchParams.set("share", STATE.shareToken);
      }
      return parsed.pathname + parsed.search;
    } catch (e) {
      return u;
    }
  }

  syncSessionTokenCookie(initialUser);

  const ROLE_LEVELS_MAP = { owner: 5, admin: 4, editor: 3, viewer: 2, guest: 1 };
  const OWNER_EMAILS_SET = new Set(["glibivanov@gatheren.com.tw", "gleb.ivanov1999@gmail.com"]);
  const ROLE_LABELS_MAP = {
    owner: "Owner · System Owner",
    admin: "Admin · Manage Users & Workflows",
    editor: "Editor · Edit Names & Run Scans",
    viewer: "Viewer · View All & Measure",
    guest: "Guest · Read-Only · Basic Tools",
  };
  function getLocalizedRoleLabel(roleKey) {
    const k = String(roleKey || "viewer").toLowerCase();
    const map = {
      owner: tr("最高管理員 · 系統擁有者", "Owner · System Owner"),
      admin: tr("管理員 · 成員與排程管理", "Admin · Manage Users & Workflows"),
      editor: tr("編輯者 · 名稱編輯與掃描處理", "Editor · Edit Names & Run Scans"),
      viewer: tr("檢視者 · 檢視與測量工具", "Viewer · View All & Measure"),
      guest: tr("訪客 · 唯讀與基礎測量", "Guest · Read-Only · Basic Tools"),
    };
    return map[k] || map.viewer;
  }

  function getCurrentUserRoleInfo() {
    if (STATE.shareToken) {
      const link = STATE.shareLinkInfo || {};
      const isSingleScan = String(link.scope_type || "scan").toLowerCase() === "scan";
      return {
        role: "guest",
        level: 1,
        label: ROLE_LABELS_MAP.guest,
        canEditNames: false,
        can_edit_names: false,
        canRunWorkflows: false,
        can_run_workflows: false,
        canManageUsers: false,
        can_manage_users: false,
        isGuestRole: true,
        isGuestSingleScan: isSingleScan,
        isSingleScanLock: isSingleScan,
        allowMeasurements: link.allow_measurements !== false,
        allowComments: Boolean(link.allow_comments),
        allowDownload: Boolean(link.allow_download),
      };
    }
    const email = String(STATE.currentUser?.email || "").trim().toLowerCase();
    const hasSessionToken = Boolean(STATE.currentUser?.session_token || STATE.currentUser?.sessionToken);
    let role = String(STATE.currentUser?.role || "guest").trim().toLowerCase();
    if (!hasSessionToken || !email || email.startsWith("guest@")) {
      role = "guest";
    } else if (OWNER_EMAILS_SET.has(email)) {
      role = "owner";
    } else if (!ROLE_LEVELS_MAP[role]) {
      role = "viewer";
    }
    const level = ROLE_LEVELS_MAP[role] || 2;
    const isGuest = role === "guest";
    return {
      role,
      level,
      label: ROLE_LABELS_MAP[role] || "Viewer",
      canEditNames: level >= 3,
      can_edit_names: level >= 3,
      canRunWorkflows: level >= 3,
      can_run_workflows: level >= 3,
      canManageUsers: level >= 4,
      can_manage_users: level >= 4,
      isGuestRole: isGuest,
      isGuestSingleScan: false,
      isSingleScanLock: false,
      allowMeasurements: true,
      allowComments: !isGuest,
      allowDownload: !isGuest,
    };
  }
  window.getCurrentUserRoleInfo = getCurrentUserRoleInfo;

  function canUserEditComment(c) {
    const roleInfo = getCurrentUserRoleInfo();
    if (roleInfo.role === "admin" || roleInfo.role === "owner" || Number(roleInfo.level) >= 4) {
      return true;
    }
    if (!roleInfo.allowComments || !c) {
      return false;
    }
    const userEmail = String(STATE.currentUser?.email || "").trim().toLowerCase();
    const userName = String(STATE.currentUser?.name || "").trim().toLowerCase();
    const cmtEmail = String(c.author_email || "").trim().toLowerCase();
    const cmtName = String(c.author_name || "").trim().toLowerCase();
    const ownerAliases = new Set(["glibivanov@gatheren.com.tw", "gleb.ivanov1999@gmail.com"]);
    if (userEmail && !userEmail.startsWith("guest@") && userEmail !== "external@gatheren.cloud") {
      return Boolean(
        (cmtEmail && cmtEmail === userEmail) ||
          (ownerAliases.has(userEmail) && ownerAliases.has(cmtEmail)) ||
          ((!cmtEmail || cmtEmail === "guest@gatheren.cloud") && cmtName && userName && cmtName === userName)
      );
    }
    if (STATE.shareToken && roleInfo.allowComments) {
      let savedGuest = "";
      try {
        savedGuest = String(localStorage.getItem("gs_guest_comment_author") || "").trim().toLowerCase();
      } catch (_) {}
      return Boolean(
        savedGuest &&
          cmtName &&
          cmtName === savedGuest &&
          (!cmtEmail || cmtEmail === "external@gatheren.cloud" || cmtEmail.startsWith("guest@"))
      );
    }
    return false;
  }
  window.canUserEditComment = canUserEditComment;

  function applyRolePermissionsToUI() {
    const info = getCurrentUserRoleInfo();
    const setDisp = (id, show, disp = "") => {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? disp : "none";
    };

    // 1. Rename Site, Rename Scan, Set Home View & Delete Scan buttons (Editor, Admin, Owner only)
    [
      "btnRenameMapSite",
      "btnRenamePopoverSite",
      "btnRenameTimelineSite",
      "btnRenameStudioSite",
      "btnRenamePreviewScan",
      "btnRenameStudioScan",
      "btnPreviewSetHomeView",
      "btnStudioSetHomeView",
      "btnDeletePreviewScan",
      "btnDeleteStudioScan",
    ].forEach((id) => setDisp(id, info.canEditNames && !STATE.isEmbedded, "inline-flex"));
    document.querySelectorAll(".gs-tile-edit-actions").forEach((el) => {
      el.style.display = info.canEditNames ? "flex" : "none";
    });

    // 2. Re-run Scan & Scan Editing Dock / Lasso Delete / Crop / Align & Merge / Optimizer / Queue buttons (Editor, Admin, Owner only; hidden for Viewer & Guest)
    setDisp("studioEditingDock", info.canRunWorkflows, "flex");
    const umbrellaBtn = document.getElementById("btnMobileEditingUmbrella");
    if (umbrellaBtn) {
      umbrellaBtn.style.display = info.canRunWorkflows ? "" : "none";
      if (!info.canRunWorkflows) {
        umbrellaBtn.classList.remove("active");
        document.getElementById("studioEditingDock")?.classList.remove("mobile-expanded");
      }
    }
    [
      "btnRerunPreviewScan",
      "btnRerunStudioScan",
      "btnOpenOptimizer",
      "btnDockLassoDelete",
      "btnDockLassoKeep",
      "btnDockOptimizer",
      "btnDockCrs",
      "btnDockAlignMerge",
      "btnDockGenerateScan",
      "pcStatusChip",
    ].forEach((id) => setDisp(id, info.canRunWorkflows, "inline-flex"));

    // 3. Sharing & Settings buttons (Full Sharing Modal is Editor+; Quick Single-Scan View & Comment Share is Viewer+)
    setDisp("btnOpenSharing", info.level >= 3, "inline-flex");
    setDisp("btnPopoverShareGroup", info.level >= 3, "inline-flex");
    setDisp("btnTimelineShare", info.level >= 3, "inline-flex");
    const canQuickShareScan = !STATE.shareToken && info.level >= 2;
    setDisp("btnStudioQuickShare", canQuickShareScan, "inline-flex");
    setDisp("btnPreviewQuickShare", canQuickShareScan, "inline-flex");

    // 3b. Recycle Bin buttons (Editor, Admin & Owner can view & restore backups; Purge is Admin/Owner)
    const canAccessBin = Boolean(info.canEditNames || info.canManageUsers);
    setDisp("btnOpenRecycleBin", canAccessBin, "inline-flex");
    setDisp("btnTimelineRecycleBin", canAccessBin, "inline-flex");
    setDisp("btnStudioRecycleBin", canAccessBin, "inline-flex");
    setDisp("btnOpenBinFromDeleteModal", canAccessBin, "inline-flex");
    setDisp("btnPurgeSelectedBinScans", info.canManageUsers, "inline-flex");
    setDisp("btnClearAllBinScans", info.canManageUsers, "inline-flex");

    // 4. Single-scan lock applies ONLY to external ?share=<token> links with scope_type="scan".
    // Interactive Guest Mode can freely browse Map, Studio, and Compare across all projects/scans.
    const lockSingleScan = Boolean(info.isSingleScanLock);
    setDisp("btnNavMap", !lockSingleScan, "inline-flex");
    setDisp("btnNavCompare", !lockSingleScan, "inline-flex");
    setDisp("btnStudioBackToTimeline", !lockSingleScan, "inline-flex");
    setDisp("studioProjectSelect", !lockSingleScan, "inline-block");
    const studioScanSel = document.getElementById("studioScanSelect");
    if (studioScanSel) studioScanSel.disabled = lockSingleScan || Boolean(STATE.multiAlign?.active);

    // 5. Basic & Guest measurement tools (Distance, Area, Coordinates, Laser, Volume, Snap, Clear) honor allowMeasurements
    [
      "btnMeasureDistance",
      "btnMeasureArea",
      "btnMeasureCoordinates",
      "btnMeasureCoords",
      "btnMeasureLaser",
      "btnMeasureVolume",
      "btnDockVolume",
      "btnDockBookmarks",
      "btnStudioSavedViews",
      "btnMeasureSnap",
      "btnSnapToggle",
      "btnMeasureClear",
      "btnClearMeasurements",
    ].forEach((id) => setDisp(id, info.allowMeasurements, "inline-flex"));
    if (!info.allowMeasurements) {
      document.getElementById("btnMeasureDistance")?.classList.remove("active");
    }
    const coordPillEl = document.querySelector(".gs-studio-coord-pill");
    if (coordPillEl) {
      coordPillEl.style.display = info.allowMeasurements ? "" : "none";
    }

    // 6. Advanced surveying tools hidden for Guest role (Viewer+ gets full surveying suite; Guest gets Distance, Area, Coords, Laser & Volume)
    const showAdvancedSurvey = !info.isGuestRole && info.allowMeasurements;
    [
      "btnMeasureAngle",
      "btnMeasureContours",
      "btnMeasureProfile",
      "btnMeasurePhotos",
      "btnDockCategorize",
      "btnDockDrainage",
      "btnDockGcpQa",
      "btnDockContours",
      "btnDockSection",
    ].forEach((id) => setDisp(id, showAdvancedSurvey, "inline-flex"));

    // 7. Comments & Deliverables honor allowComments / allowDownload
    setDisp("btnDockComments", info.allowComments, "inline-flex");
    setDisp("btnStudioDownloadObj", info.allowDownload, "inline-flex");
    setDisp("btnStudioSurveyReport", showAdvancedSurvey && info.allowDownload, "inline-flex");

    // Hide redundant dock dividers when measurement/surveying groups are hidden (e.g. View & Comment Only links)
    const dockDividers = document.querySelectorAll("#bimBottomDock > .bim-dock-divider");
    if (dockDividers.length >= 3) {
      dockDividers[0].style.display = info.allowMeasurements ? "" : "none";
      dockDividers[1].style.display = info.allowMeasurements && (showAdvancedSurvey || info.allowComments) ? "" : "none";
      dockDividers[2].style.display = info.allowComments || info.allowMeasurements ? "" : "none";
    }

    // 8. If current active Studio tool is no longer permitted after role change, reset cleanly
    const advTools = new Set(["angle", "contours", "profile", "section", "photos", "categorize"]);
    const wfTools = new Set(["optimizer", "crs", "generate_scan", "crop", "crop_delete", "align_merge"]);
    if (!info.canRunWorkflows && STATE.multiAlign?.active && typeof exitMultiScanAlignMode === "function") {
      exitMultiScanAlignMode(true);
    }
    if (
      (!showAdvancedSurvey && advTools.has(STATE.activeTool)) ||
      (!info.canRunWorkflows && wfTools.has(STATE.activeTool)) ||
      (!info.allowComments && STATE.activeTool === "comments") ||
      (!info.allowMeasurements && ["distance", "area", "coordinates", "laser", "volume"].includes(STATE.activeTool))
    ) {
      STATE.activeTool = info.allowMeasurements ? "distance" : "orbit";
      document.getElementById("studioSidePanel")?.classList.remove("active");
    }

    if (typeof syncMultiAlignToolAvailability === "function") {
      syncMultiAlignToolAvailability();
    }

    // 9. Critical/Secret/Internal Settings (Admin/Owner ONLY: API keys, GChat webhooks/handles, User Roles & Permissions, PC Daemon, Pix4D Pipeline)
    setDisp("adminControlPanelSection", info.canManageUsers, "block");
    setDisp("settingsServiceAccountCard", info.canManageUsers, "block");
    setDisp("settingsPix4dPipelineSection", info.canManageUsers, "block");
    setDisp("gateExistingUsersSection", info.canManageUsers, "block");
    setDisp("btnJumpQueueToSettings", info.canManageUsers, "inline-flex");

    // Role badge in Settings Admin Control Panel
    const badgeRole = document.getElementById("badgeCurrentUserRoleLevel") || document.getElementById("adminCurrentUserRolePill");
    if (badgeRole) {
      badgeRole.textContent = `Active Role: L${info.level} — ${info.label}`;
    }
    const adminForm = document.getElementById("adminUserEditorForm");
    if (adminForm) {
      adminForm.style.display = info.canManageUsers ? "grid" : "none";
    }
    if (STATE.activeView === "studio" && typeof window.renderCommentPins3D === "function") {
      window.renderCommentPins3D();
    }
  }

  async function apiGet(url) {
    const sep = url.includes("?") ? "&" : "?";
    const fullUrl = STATE.shareToken ? `${url}${sep}share=${encodeURIComponent(STATE.shareToken)}` : url;
    const res = await fetch(fullUrl, { headers: apiHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function apiPost(url, body = {}) {
    const sep = url.includes("?") ? "&" : "?";
    const fullUrl = STATE.shareToken ? `${url}${sep}share=${encodeURIComponent(STATE.shareToken)}` : url;
    const isLongAction =
      url.startsWith("/api/optimizer/") || url === "/api/scans/merge" || url === "/api/optimizer/merge";
    const maxAttempts = isLongAction ? 2 : 1;
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 2500));
      }
      const res = await fetch(fullUrl, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        lastErr = new Error(data.error || `HTTP ${res.status}`);
        if (res.status === 503 && attempt + 1 < maxAttempts) {
          continue;
        }
        throw lastErr;
      }
      if (url.startsWith("/api/survey/") && !body?.only_update_filters) {
        SHARE_TELEMETRY.recordMeasurement(url.replace("/api/survey/", "survey_"));
      }
      return data;
    }
    throw lastErr || new Error("Request failed");
  }

  // Register Client-Side Offline Service Worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[GatheringScans] ServiceWorker registration note:", err);
    });
  }


