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
    libraryFolders: (_embedBoot && Array.isArray(_embedBoot.library_folders)) ? _embedBoot.library_folders : [],
    leftPaneMode: "map", // 'map' = Google Map Sites | 'library' = 3D Model Library with Folders
    selectedLibraryFolder: "ALL",
    librarySearchQuery: "",
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
    embedAutoRotateEnabled: (function () {
      const urlRot = String(_urlParams.get("autorotate") || _urlParams.get("rotate") || "").trim().toLowerCase();
      if (urlRot === "0" || urlRot === "false" || urlRot === "off") return false;
      if (urlRot === "1" || urlRot === "true" || urlRot === "on") return true;
      return true;
    })(),
    previewAutoRotateEnabled: (function () {
      const urlRot = String(_urlParams.get("autorotate") || _urlParams.get("rotate") || "").trim().toLowerCase();
      if (urlRot === "0" || urlRot === "false" || urlRot === "off") return false;
      if (urlRot === "1" || urlRot === "true" || urlRot === "on") return true;
      return true;
    })(),
    studioAutoRotateEnabled: false,
    autoRotateEnabled: (function () {
      const urlRot = String(_urlParams.get("autorotate") || _urlParams.get("rotate") || "").trim().toLowerCase();
      if (urlRot === "0" || urlRot === "false" || urlRot === "off") return false;
      if (urlRot === "1" || urlRot === "true" || urlRot === "on") return true;
      return initialIsEmbedded ? true : false;
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
  function getProjectGroupsList(filterQuery = "", { includeLibrary = false } = {}) {
    const q = String(filterQuery || "").trim().toLowerCase();
    const map = new Map();
    const isGeorefScan = (sc) =>
      sc &&
      sc.group_type !== "library" &&
      sc.lat !== null &&
      sc.lat !== undefined &&
      sc.lon !== null &&
      sc.lon !== undefined &&
      Number.isFinite(Number(sc.lat)) &&
      Number.isFinite(Number(sc.lon)) &&
      (Math.abs(Number(sc.lat)) > 0.001 || Math.abs(Number(sc.lon)) > 0.001) &&
      !String(sc.crs || "").toUpperCase().includes("LOCAL");

    STATE.scans.forEach((s) => {
      if (!includeLibrary && typeof isLibraryScan === "function" && isLibraryScan(s)) {
        return;
      }
      const g = s.project_group || "Unassigned Site";
      if (!map.has(g)) {
        map.set(g, {
          project_group: g,
          project_name_zh: s.project_name_zh || "",
          group_type: s.group_type || "site",
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
    const mapGroups = getProjectGroupsList("", { includeLibrary: false });
    const allGroupsWithLib = getProjectGroupsList("", { includeLibrary: true });
    const activeCatalogGroups = STATE.leftPaneMode === "library" || STATE.activeView === "studio" ? allGroupsWithLib : mapGroups;
    if (projectGroup === "__all__") {
      STATE.activeProjectGroup = "__all__";
    } else if (projectGroup && activeCatalogGroups.some((g) => g.project_group === projectGroup)) {
      STATE.activeProjectGroup = projectGroup;
    } else if (
      STATE.activeScan &&
      STATE.activeScan.project_group &&
      STATE.activeProjectGroup !== "__all__" &&
      activeCatalogGroups.some((g) => g.project_group === STATE.activeScan.project_group)
    ) {
      STATE.activeProjectGroup = STATE.activeScan.project_group;
    } else if (!STATE.activeProjectGroup && mapGroups.length > 0) {
      STATE.activeProjectGroup = mapGroups[0].project_group;
    }

    // 1. Populate Map Project Selector (#mapProjectSelect) strictly with Map Sites (never Library folders)
    const mapProjSel = document.getElementById("mapProjectSelect");
    if (mapProjSel) {
      const filteredGroups = getProjectGroupsList(STATE.projectFilterQuery, { includeLibrary: false });
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
        opt.textContent = typeof formatGroupDisplayName === "function" ? formatGroupDisplayName(grp.project_group, grp.project_name_zh) : grp.project_group;
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
      const groupsForSel =
        selId === "studioProjectSelect" || (selId === "timelineProjectSelect" && STATE.leftPaneMode === "library")
          ? allGroupsWithLib
          : mapGroups;
      sel.innerHTML = "";
      if (selId === "timelineProjectSelect") {
        const allOpt = document.createElement("option");
        allOpt.value = "__all__";
        allOpt.textContent = tr("全部工區", "All Projects");
        sel.appendChild(allOpt);
      }
      groupsForSel.forEach((grp) => {
        const opt = document.createElement("option");
        opt.value = grp.project_group;
        opt.textContent = typeof formatGroupDisplayName === "function" ? formatGroupDisplayName(grp.project_group, grp.project_name_zh) : grp.project_group;
        sel.appendChild(opt);
      });
      if (selId === "timelineProjectSelect" && STATE.activeProjectGroup === "__all__") {
        sel.value = "__all__";
      } else if (STATE.activeProjectGroup && groupsForSel.some((g) => g.project_group === STATE.activeProjectGroup)) {
        sel.value = STATE.activeProjectGroup;
      } else if (groupsForSel[0]) {
        sel.value = groupsForSel[0].project_group;
      }
    });

    const resolvedSpecificGroup =
      STATE.activeProjectGroup && STATE.activeProjectGroup !== "__all__"
        ? STATE.activeProjectGroup
        : STATE.activeScan?.project_group || mapGroups[0]?.project_group || allGroupsWithLib[0]?.project_group || "";

    // Update hidden badges for backward compatibility
    const studioBadge = document.getElementById("studioProjectGroupBadge");
    if (studioBadge) studioBadge.textContent = typeof formatGroupDisplayName === "function" ? formatGroupDisplayName(resolvedSpecificGroup) : resolvedSpecificGroup;
    const cmpBadge = document.getElementById("compareProjectGroupBadge");
    if (cmpBadge) cmpBadge.textContent = typeof formatGroupDisplayName === "function" ? formatGroupDisplayName(resolvedSpecificGroup) : resolvedSpecificGroup;

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
      if (typeof getOrAssignExternalReviewerName === "function") {
        return getOrAssignExternalReviewerName();
      }
      try {
        const savedGuest = (localStorage.getItem("gs_guest_comment_author") || "").trim();
        if (savedGuest && !["external reviewer", "guest viewer", "guest", "anonymous"].includes(savedGuest.toLowerCase())) {
          return savedGuest;
        }
      } catch (_) {}
      const uName = String(STATE.currentUser?.name || "").trim();
      if (uName && !["guest", "guest viewer", "anonymous", "external reviewer"].includes(uName.toLowerCase())) {
        return uName;
      }
      return "Sturdy lemon";
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

  const RANDOM_REVIEWER_ADJECTIVES = [
    "Sturdy", "Clever", "Brisk", "Calm", "Swift", "Bright", "Gentle", "Bold", "Sunny", "Nimble",
    "Steady", "Vivid", "Crisp", "Mellow", "Lucky", "Brave", "Quiet", "Lively", "Warm", "Noble",
  ];
  const RANDOM_REVIEWER_NOUNS = [
    "lemon", "otter", "falcon", "pebble", "mango", "cedar", "pine", "kiwi", "badger", "heron",
    "maple", "melon", "walnut", "peach", "finch", "panda", "lotus", "olive", "acorn", "spruce",
  ];
  const GENERIC_REVIEWER_PLACEHOLDERS = new Set([
    "external reviewer",
    "guest viewer",
    "guest",
    "anonymous",
    "engineer",
  ]);

  function getOrAssignExternalReviewerName() {
    // 1. Prefer Google account name from active session or saved browser profile if available
    const curEmail = String(STATE.currentUser?.email || "").trim().toLowerCase();
    const curName = String(STATE.currentUser?.name || "").trim();
    if (
      curName &&
      curEmail &&
      !curEmail.startsWith("guest@") &&
      curEmail !== "external@gatheren.cloud" &&
      !GENERIC_REVIEWER_PLACEHOLDERS.has(curName.toLowerCase())
    ) {
      return curName;
    }
    try {
      for (const storageKey of ["gathering_user_profile", "gs_current_user", "google_user_profile"]) {
        const raw = localStorage.getItem(storageKey);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const pEmail = String(parsed?.email || "").trim().toLowerCase();
        const pName = String(parsed?.name || parsed?.given_name || "").trim();
        if (
          pName &&
          pEmail &&
          !pEmail.startsWith("guest@") &&
          pEmail !== "external@gatheren.cloud" &&
          !GENERIC_REVIEWER_PLACEHOLDERS.has(pName.toLowerCase())
        ) {
          return pName;
        }
      }
    } catch (_) {}

    // 2. Check persisted custom or previously generated 2-word reviewer name
    try {
      const saved = String(localStorage.getItem("gs_guest_comment_author") || "").trim();
      if (saved && !GENERIC_REVIEWER_PLACEHOLDERS.has(saved.toLowerCase())) {
        return saved;
      }
    } catch (_) {}

    // 3. Generate a friendly 2-word name like "Sturdy lemon" and persist it
    const adj = RANDOM_REVIEWER_ADJECTIVES[Math.floor(Math.random() * RANDOM_REVIEWER_ADJECTIVES.length)] || "Sturdy";
    const noun = RANDOM_REVIEWER_NOUNS[Math.floor(Math.random() * RANDOM_REVIEWER_NOUNS.length)] || "lemon";
    const generated = `${adj} ${noun}`;
    try {
      localStorage.setItem("gs_guest_comment_author", generated);
    } catch (_) {}
    return generated;
  }
  window.getOrAssignExternalReviewerName = getOrAssignExternalReviewerName;

  function getCurrentUserRoleInfo() {
    if (STATE.shareToken) {
      const link = STATE.shareLinkInfo || {};
      const isSingleScan = String(link.scope_type || "scan").toLowerCase() === "scan";
      const isQuickViewComment = String(link.label || "").startsWith("View & Comment");
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
        allowMeasurements: link.allow_measurements !== false || isQuickViewComment || Boolean(link.allow_comments),
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
      if (
        (cmtEmail && cmtEmail === userEmail) ||
        (ownerAliases.has(userEmail) && ownerAliases.has(cmtEmail)) ||
        ((!cmtEmail || cmtEmail === "guest@gatheren.cloud" || cmtEmail === "external@gatheren.cloud") && cmtName && userName && cmtName === userName)
      ) {
        return true;
      }
    }
    if (STATE.shareToken && roleInfo.allowComments) {
      const candidateNames = new Set();
      try {
        const lsName = String(localStorage.getItem("gs_guest_comment_author") || "").trim().toLowerCase();
        if (lsName) candidateNames.add(lsName);
      } catch (_) {}
      const assignedName = String(getOrAssignExternalReviewerName() || "").trim().toLowerCase();
      if (assignedName) candidateNames.add(assignedName);
      if (userName) candidateNames.add(userName);
      return Boolean(
        cmtName &&
          candidateNames.has(cmtName) &&
          (!cmtEmail || cmtEmail === "external@gatheren.cloud" || cmtEmail.startsWith("guest@") || cmtEmail === userEmail)
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

    // 1. Rename Site, Rename Scan, Move Scan, Library Folder Controls, Set Home View & Delete Scan buttons (Editor, Admin, Owner only)
    [
      "btnRenameMapSite",
      "btnRenamePopoverSite",
      "btnRenameTimelineSite",
      "btnRenameStudioSite",
      "btnRenamePreviewScan",
      "btnRenameStudioScan",
      "btnMovePreviewScan",
      "btnMoveStudioScan",
      "btnCreateLibraryFolder",
      "btnRenameLibraryFolder",
      "btnDeleteLibraryFolder",
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
    setDisp("btnNavLibrary", !lockSingleScan, "inline-flex");
    setDisp("btnNavCompare", !lockSingleScan, "inline-flex");
    setDisp("mainModeSwitcher", !lockSingleScan, "inline-flex");
    setDisp("btnStudioBackToTimeline", !lockSingleScan, "inline-flex");
    setDisp("studioProjectSelect", !lockSingleScan, "inline-block");
    if (document.body) {
      document.body.classList.toggle("gs-single-scan-share", lockSingleScan);
    }
    const studioScanSel = document.getElementById("studioScanSelect");
    if (studioScanSel) studioScanSel.disabled = lockSingleScan || Boolean(STATE.multiAlign?.active);

    // 5. Basic & Guest measurement tools (Distance, Angle, Area, Coordinates, Laser, Volume, Snap, Clear) honor allowMeasurements
    [
      "btnMeasureDistance",
      "btnMeasureAngle",
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
    setDisp("btnMeasurePhotos", Boolean(info.allowMeasurements || info.allowComments), "inline-flex");
    if (!info.allowMeasurements) {
      document.getElementById("btnMeasureDistance")?.classList.remove("active");
    }
    const coordPillEl = document.querySelector(".gs-studio-coord-pill");
    if (coordPillEl) {
      coordPillEl.style.display = info.allowMeasurements ? "" : "none";
    }

    // 6. Advanced surveying tools hidden for Guest role (Viewer+ gets full surveying suite; Guest gets Distance, Angle, Area, Coords, Laser, Volume & Photos)
    const showAdvancedSurvey = !info.isGuestRole && info.allowMeasurements;
    [
      "btnMeasureContours",
      "btnMeasureProfile",
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
    const advTools = new Set(["contours", "profile", "section", "categorize"]);
    const wfTools = new Set(["optimizer", "crs", "generate_scan", "crop", "crop_delete", "align_merge"]);
    if (!info.canRunWorkflows && STATE.multiAlign?.active && typeof exitMultiScanAlignMode === "function") {
      exitMultiScanAlignMode(true);
    }
    if (
      (!showAdvancedSurvey && advTools.has(STATE.activeTool)) ||
      (!info.canRunWorkflows && wfTools.has(STATE.activeTool)) ||
      (!info.allowComments && STATE.activeTool === "comments") ||
      (!info.allowMeasurements && !info.allowComments && STATE.activeTool === "photos") ||
      (!info.allowMeasurements && ["distance", "angle", "area", "coordinates", "laser", "volume"].includes(STATE.activeTool))
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

  // ============================================================================
  // 3D Gaussian Splat (.gsplat) WebGL Instanced EWA Splat Renderer
  // ============================================================================

  const _GSPLAT_BUFFER_CACHE = new Map();

  function disposeGaussianSplatFromContext(ctx) {
    if (!ctx || !ctx.gsplatState) return;
    const st = ctx.gsplatState;
    ctx.gsplatState = null;
    if (st.mesh) {
      if (st.mesh.parent) st.mesh.parent.remove(st.mesh);
      if (st.mesh.geometry) st.mesh.geometry.dispose();
      if (st.mesh.material) st.mesh.material.dispose();
    }
  }

  function _hideRaycastSurfelMeshes(tilesGroup) {
    if (!tilesGroup) return;
    tilesGroup.traverse((child) => {
      if (child && child.isMesh && child.material && !child.userData?.isGaussianSplatMesh) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
          if (!m) return;
          m.transparent = true;
          m.opacity = 0.0;
          m.depthWrite = false;
          m.colorWrite = false;
          m.needsUpdate = true;
        });
      }
    });
  }

  function isScanOrTilesetGaussianSplat(scan, tr) {
    if (scan && scan.is_gaussian_splat) return true;
    if (tr) {
      if (tr.root?.extras?.is_gaussian_splat || tr.root?.parent?.extras?.is_gaussian_splat) return true;
      const tsMap = tr.tileSets;
      if (tsMap && typeof tsMap === "object") {
        for (const k of Object.keys(tsMap)) {
          if (tsMap[k]?.extras?.is_gaussian_splat || tsMap[k]?.root?.extras?.is_gaussian_splat) return true;
        }
      }
    }
    return false;
  }

  async function loadGaussianSplatIntoContext(ctx, scan, prefix = "studio", onReady = null) {
    disposeGaussianSplatFromContext(ctx);
    const isGsplat = isScanOrTilesetGaussianSplat(scan, ctx?.tilesRenderer);
    if (!ctx || !scan || !isGsplat) return null;
    scan.is_gaussian_splat = true;
    const THREE = window.THREE;
    if (!THREE || !ctx.modelPivot) return null;
    ctx._gsplatLoading = true;

    const splatUrl =
      scan.splat_url ||
      `/stream/${encodeURIComponent(scan.scan_id)}/tiles/splats.gsplat` +
        (STATE.shareToken ? `?share=${encodeURIComponent(STATE.shareToken)}` : "");

    const expectedScanId = scan.scan_id;
    let parsed = _GSPLAT_BUFFER_CACHE.get(splatUrl);
    if (!parsed) {
      try {
        const resp = await fetch(splatUrl, { headers: apiHeaders() });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        if (buf.byteLength < 16) throw new Error("Invalid .gsplat header");
        const dv = new DataView(buf);
        const magic = dv.getUint32(0, true);
        if (magic !== 0x4c505347 && magic !== 0x544c5053) throw new Error("Unexpected .gsplat magic header");
        const totalCount = dv.getUint32(8, true);
        const n = Math.min(totalCount, Math.floor((buf.byteLength - 16) / 32));
        const f32 = new Float32Array(buf, 16, n * 8);
        const u8 = new Uint8Array(buf, 16, n * 32);

        const pos = new Float32Array(n * 3);
        const scale = new Float32Array(n * 3);
        const quat = new Float32Array(n * 4);
        const col = new Float32Array(n * 4);

        for (let i = 0; i < n; i++) {
          const fBase = i * 8;
          const bBase = i * 32;
          const i3 = i * 3;
          const i4 = i * 4;
          pos[i3] = f32[fBase];
          pos[i3 + 1] = f32[fBase + 1];
          pos[i3 + 2] = f32[fBase + 2];

          scale[i3] = Math.max(0.0008, Math.min(0.45, f32[fBase + 3]));
          scale[i3 + 1] = Math.max(0.0008, Math.min(0.45, f32[fBase + 4]));
          scale[i3 + 2] = Math.max(0.0008, Math.min(0.45, f32[fBase + 5]));

          col[i4] = u8[bBase + 24] / 255.0;
          col[i4 + 1] = u8[bBase + 25] / 255.0;
          col[i4 + 2] = u8[bBase + 26] / 255.0;
          col[i4 + 3] = u8[bBase + 27] / 255.0;

          let qx = (u8[bBase + 28] / 255.0) * 2.0 - 1.0;
          let qy = (u8[bBase + 29] / 255.0) * 2.0 - 1.0;
          let qz = (u8[bBase + 30] / 255.0) * 2.0 - 1.0;
          let qw = (u8[bBase + 31] / 255.0) * 2.0 - 1.0;
          const qn = Math.hypot(qx, qy, qz, qw) || 1.0;
          quat[i4] = qx / qn;
          quat[i4 + 1] = qy / qn;
          quat[i4 + 2] = qz / qn;
          quat[i4 + 3] = qw / qn;
        }
        parsed = { count: n, pos, scale, quat, col };
        if (_GSPLAT_BUFFER_CACHE.size >= 6) {
          const oldestKey = _GSPLAT_BUFFER_CACHE.keys().next().value;
          _GSPLAT_BUFFER_CACHE.delete(oldestKey);
        }
        _GSPLAT_BUFFER_CACHE.set(splatUrl, parsed);
      } catch (err) {
        ctx._gsplatLoading = false;
        console.warn("[GaussianSplat] Failed loading .gsplat stream:", err);
        return null;
      }
    }

    if (
      (prefix === "studio" && STATE.activeScanId !== expectedScanId) ||
      (prefix === "preview" && ctx.currentScanId && ctx.currentScanId !== expectedScanId)
    ) {
      ctx._gsplatLoading = false;
      return null;
    }

    const totalSplats = parsed.count;
    const baseGeom = new THREE.InstancedBufferGeometry();
    const quadVerts = new Float32Array([
      -1.0, -1.0, 0.0,
       1.0, -1.0, 0.0,
       1.0,  1.0, 0.0,
      -1.0,  1.0, 0.0,
    ]);
    baseGeom.setAttribute("position", new THREE.BufferAttribute(quadVerts, 3));
    baseGeom.setIndex([0, 1, 2, 0, 2, 3]);

    const sortedPos = new Float32Array(parsed.pos);
    const sortedScale = new Float32Array(parsed.scale);
    const sortedQuat = new Float32Array(parsed.quat);
    const sortedCol = new Float32Array(parsed.col);

    const attrCenter = new THREE.InstancedBufferAttribute(sortedPos, 3);
    const attrScale = new THREE.InstancedBufferAttribute(sortedScale, 3);
    const attrQuat = new THREE.InstancedBufferAttribute(sortedQuat, 4);
    const attrColor = new THREE.InstancedBufferAttribute(sortedCol, 4);
    attrCenter.setUsage(THREE.DynamicDrawUsage);
    attrScale.setUsage(THREE.DynamicDrawUsage);
    attrQuat.setUsage(THREE.DynamicDrawUsage);
    attrColor.setUsage(THREE.DynamicDrawUsage);

    baseGeom.setAttribute("splatCenter", attrCenter);
    baseGeom.setAttribute("splatScale", attrScale);
    baseGeom.setAttribute("splatQuat", attrQuat);
    baseGeom.setAttribute("splatColor", attrColor);
    baseGeom.instanceCount = totalSplats;

    const w = Math.max(1, ctx.container?.clientWidth || 800);
    const h = Math.max(1, ctx.container?.clientHeight || 600);
    const dpr = ctx.renderer ? ctx.renderer.getPixelRatio() : (window.devicePixelRatio || 1);
    const fy = (0.5 * h * dpr) / Math.tan(THREE.MathUtils.degToRad((ctx.camera?.fov || 48) * 0.5));
    const fx = fy;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uViewport: { value: new THREE.Vector2(w * dpr, h * dpr) },
        uFocal: { value: new THREE.Vector2(fx, fy) },
        uBrightness: { value: Number(STATE.scanBrightness || 1.0) },
      },
      vertexShader: `
        attribute vec3 splatCenter;
        attribute vec3 splatScale;
        attribute vec4 splatQuat;
        attribute vec4 splatColor;
        uniform vec2 uViewport;
        uniform vec2 uFocal;
        varying vec4 vColor;
        varying vec3 vConic;
        varying vec2 vDeltaPx;

        mat3 quatToMat3(vec4 q) {
          float x = q.x, y = q.y, z = q.z, w = q.w;
          float x2 = x + x, y2 = y + y, z2 = z + z;
          float xx = x * x2, xy = x * y2, xz = x * z2;
          float yy = y * y2, yz = y * z2, zz = z * z2;
          float wx = w * x2, wy = w * y2, wz = w * z2;
          return mat3(
            1.0 - (yy + zz), xy + wz, xz - wy,
            xy - wz, 1.0 - (xx + zz), yz + wx,
            xz + wy, yz - wx, 1.0 - (xx + yy)
          );
        }

        void main() {
          vec4 viewCenter = modelViewMatrix * vec4(splatCenter, 1.0);
          vec4 clipCenter = projectionMatrix * viewCenter;
          if (viewCenter.z > -0.05 || splatColor.a < 0.006) {
            gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
            return;
          }

          mat3 R = quatToMat3(splatQuat);
          mat3 S = mat3(
            splatScale.x, 0.0, 0.0,
            0.0, splatScale.y, 0.0,
            0.0, 0.0, splatScale.z
          );
          mat3 M = R * S;
          mat3 Vrk = M * transpose(M);

          float tz = viewCenter.z;
          float tz2 = tz * tz;
          float limX = 1.35 * abs(tz);
          float limY = 1.35 * abs(tz);
          float tx = clamp(viewCenter.x, -limX, limX);
          float ty = clamp(viewCenter.y, -limY, limY);

          mat3 J = mat3(
            uFocal.x / tz, 0.0, -(uFocal.x * tx) / tz2,
            0.0, uFocal.y / tz, -(uFocal.y * ty) / tz2,
            0.0, 0.0, 0.0
          );
          mat3 W = transpose(mat3(modelViewMatrix));
          mat3 T = W * J;
          mat3 cov2d = transpose(T) * Vrk * T;

          float c00 = cov2d[0][0] + 0.3;
          float c01 = cov2d[0][1];
          float c11 = cov2d[1][1] + 0.3;
          float det = max(c00 * c11 - c01 * c01, 1e-6);

          vConic = vec3(c11 / det, -c01 / det, c00 / det);
          vColor = splatColor;

          float maxPix = min(max(uViewport.x, uViewport.y) * 0.25, 256.0);
          vec2 radPx = min(vec2(2.85 * sqrt(c00), 2.85 * sqrt(c11)), vec2(maxPix));
          vec2 offsetPx = position.xy * radPx;
          vDeltaPx = offsetPx;

          vec2 screenOffset = offsetPx * 2.0 / uViewport;
          gl_Position = vec4(clipCenter.xy / clipCenter.w + screenOffset, clipCenter.z / clipCenter.w, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uBrightness;
        varying vec4 vColor;
        varying vec3 vConic;
        varying vec2 vDeltaPx;

        void main() {
          float power = -0.5 * (
            vConic.x * vDeltaPx.x * vDeltaPx.x +
            2.0 * vConic.y * vDeltaPx.x * vDeltaPx.y +
            vConic.z * vDeltaPx.y * vDeltaPx.y
          );
          if (power > 0.0 || power < -4.0) discard;
          float alpha = min(0.99, vColor.a * exp(power));
          if (alpha < (1.0 / 255.0)) discard;
          vec3 rgb = clamp(vColor.rgb * uBrightness, 0.0, 1.0);
          gl_FragColor = vec4(rgb, alpha);
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(baseGeom, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    mesh.userData.isGaussianSplatMesh = true;
    if (ctx.tilesRenderer && ctx.tilesRenderer.group) {
      mesh.position.copy(ctx.tilesRenderer.group.position);
      _hideRaycastSurfelMeshes(ctx.tilesRenderer.group);
    }
    ctx.modelPivot.add(mesh);

    ctx.gsplatState = {
      scanId: expectedScanId,
      mesh,
      material,
      geom: baseGeom,
      src: parsed,
      attrCenter,
      attrScale,
      attrQuat,
      attrColor,
      lastCamDir: new THREE.Vector3(0, 0, 0),
      lastActiveCount: 0,
      sortCounts: new Uint32Array(65536),
      sortKeys: new Uint16Array(totalSplats),
      sortIndices: new Uint32Array(totalSplats),
    };

    ctx._gsplatLoading = false;
    updateGaussianSplatForContext(ctx, prefix, true);
    if (ctx.renderer && ctx.scene && ctx.camera) {
      ctx.renderer.render(ctx.scene, ctx.camera);
    }
    if (typeof onReady === "function") onReady(mesh);
    return mesh;
  }

  function updateGaussianSplatForContext(ctx, prefix = "studio", forceSort = false) {
    if (!ctx || !ctx.gsplatState || !ctx.camera || !ctx.renderer) return;
    const THREE = window.THREE;
    const st = ctx.gsplatState;
    if (!st.mesh || !st.src) return;

    if (ctx.tilesRenderer && ctx.tilesRenderer.group) {
      st.mesh.position.copy(ctx.tilesRenderer.group.position);
      _hideRaycastSurfelMeshes(ctx.tilesRenderer.group);
    }

    const w = Math.max(1, ctx.container?.clientWidth || 800);
    const h = Math.max(1, ctx.container?.clientHeight || 600);
    const dpr = ctx.renderer.getPixelRatio() || 1;
    const fy = (0.5 * h * dpr) / Math.tan(THREE.MathUtils.degToRad((ctx.camera.fov || 48) * 0.5));
    st.material.uniforms.uViewport.value.set(w * dpr, h * dpr);
    st.material.uniforms.uFocal.value.set(fy, fy);
    st.material.uniforms.uBrightness.value = Number(STATE.scanBrightness || 1.0);

    const mode = String((prefix === "preview" ? STATE.previewLodMode : STATE.scanLodMode) || ctx.qualityMode || "auto");
    const total = st.src.count;
    const activeCount = mode === "rough" ? Math.min(total, 250000) : total;

    // Camera view direction transformed into Z-up modelPivot space (since modelPivot has rotation.x = -PI/2)
    const camDirWorld = new THREE.Vector3();
    ctx.camera.getWorldDirection(camDirWorld);
    // Inverse of R_x(-90 deg) is R_x(+90 deg): (x, y, z)_world -> (x, -z, y)_zup
    const vx = camDirWorld.x;
    const vy = -camDirWorld.z;
    const vz = camDirWorld.y;

    const dirDelta =
      Math.hypot(vx - st.lastCamDir.x, vy - st.lastCamDir.y, vz - st.lastCamDir.z) +
      (st.lastActiveCount !== activeCount ? 1.0 : 0.0);

    if (!forceSort && dirDelta < 0.008) return;
    st.lastCamDir.set(vx, vy, vz);
    st.lastActiveCount = activeCount;

    const srcPos = st.src.pos;
    const srcScale = st.src.scale;
    const srcQuat = st.src.quat;
    const srcCol = st.src.col;

    // 16-bit counting sort from farthest to nearest (back-to-front alpha compositing)
    let minD = Infinity;
    let maxD = -Infinity;
    for (let i = 0; i < activeCount; i++) {
      const i3 = i * 3;
      const d = srcPos[i3] * vx + srcPos[i3 + 1] * vy + srcPos[i3 + 2] * vz;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
    const span = Math.max(1e-5, maxD - minD);
    const invSpan = 65535.0 / span;
    const counts = st.sortCounts;
    const keys = st.sortKeys;
    const indices = st.sortIndices;
    counts.fill(0);

    for (let i = 0; i < activeCount; i++) {
      const i3 = i * 3;
      const d = srcPos[i3] * vx + srcPos[i3 + 1] * vy + srcPos[i3 + 2] * vz;
      // Farthest (larger d along view forward vector) -> smaller bucket index 0..65535
      const k = Math.max(0, Math.min(65535, ((maxD - d) * invSpan) | 0));
      keys[i] = k;
      counts[k]++;
    }
    let sum = 0;
    for (let b = 0; b < 65536; b++) {
      const c = counts[b];
      counts[b] = sum;
      sum += c;
    }
    for (let i = 0; i < activeCount; i++) {
      const k = keys[i];
      indices[counts[k]++] = i;
    }

    const dstPos = st.attrCenter.array;
    const dstScale = st.attrScale.array;
    const dstQuat = st.attrQuat.array;
    const dstCol = st.attrColor.array;

    for (let outIdx = 0; outIdx < activeCount; outIdx++) {
      const srcIdx = indices[outIdx];
      const s3 = srcIdx * 3;
      const s4 = srcIdx * 4;
      const d3 = outIdx * 3;
      const d4 = outIdx * 4;

      dstPos[d3] = srcPos[s3];
      dstPos[d3 + 1] = srcPos[s3 + 1];
      dstPos[d3 + 2] = srcPos[s3 + 2];

      dstScale[d3] = srcScale[s3];
      dstScale[d3 + 1] = srcScale[s3 + 1];
      dstScale[d3 + 2] = srcScale[s3 + 2];

      dstQuat[d4] = srcQuat[s4];
      dstQuat[d4 + 1] = srcQuat[s4 + 1];
      dstQuat[d4 + 2] = srcQuat[s4 + 2];
      dstQuat[d4 + 3] = srcQuat[s4 + 3];

      dstCol[d4] = srcCol[s4];
      dstCol[d4 + 1] = srcCol[s4 + 1];
      dstCol[d4 + 2] = srcCol[s4 + 2];
      dstCol[d4 + 3] = srcCol[s4 + 3];
    }

    st.geom.instanceCount = activeCount;
    st.attrCenter.needsUpdate = true;
    st.attrScale.needsUpdate = true;
    st.attrQuat.needsUpdate = true;
    st.attrColor.needsUpdate = true;
  }

  // ============================================================================
  // 3D Model Library with Folders & Admin Move Scan Between Sites and Folders
  // ============================================================================

  function isLibraryScan(scan) {
    if (!scan) return false;
    if (scan.group_type === "library") return true;
    if (scan.group_type === "site") return false;
    const crs = String(scan.crs || "").toUpperCase();
    return scan.lat == null || scan.lon == null || crs.includes("LOCAL");
  }

  function normalizeCanonicalFolderName(rawName, rawZh = "") {
    const clean = String(rawName || "").trim();
    const low = clean.toLowerCase();
    if (low === "people" || low === "人物與角色" || low === "人物與角色 (people)") {
      return { en: "People", zh: "人物與角色" };
    }
    if (low === "equipment" || low === "機具與設備" || low === "機具與設備 (equipment)") {
      return { en: "Equipment", zh: "機具與設備" };
    }
    if (
      low === "general models" ||
      low === "一般 3d 模型" ||
      low === "一般 3d 模型 (general models)" ||
      low === "一般非地理定位 3d 模型"
    ) {
      return { en: "General Models", zh: "一般 3D 模型" };
    }
    const m = clean.match(/^([^\(（]+?)\s*[\(（]([A-Za-z0-9\s&/\-_]+)[\)）]$/);
    if (m) {
      return {
        en: m[2].trim(),
        zh: m[1].trim(),
      };
    }
    const cleanZh = String(rawZh || "")
      .replace(/\s*(工程掃描群組|3D\s*模型|模型庫|Engineering Scan Group).*$/i, "")
      .replace(/\s*[\(（][A-Za-z0-9\s&/\-_]+[\)）]\s*/g, "")
      .trim();
    return {
      en: clean,
      zh: cleanZh || clean,
    };
  }

  function formatGroupDisplayName(rawName, rawZh = "") {
    if (!rawName || rawName === "__all__") {
      return tr("全部工區", "All Projects");
    }
    const norm = normalizeCanonicalFolderName(rawName, rawZh);
    const lang = typeof window.getAppLanguage === "function" ? window.getAppLanguage() : "zh-TW";
    if (lang === "en") {
      return norm.en;
    }
    // In zh-TW: for library folders or sites with pure Chinese names, show pure Chinese without any parenthetical English
    if (norm.en === "People" || norm.en === "Equipment" || norm.en === "General Models") {
      return norm.zh;
    }
    return norm.en;
  }

  function formatGroupSubtitleDisplay(rawName, rawZh = "", isLib = false) {
    if (!rawName || rawName === "__all__") {
      return tr("跨工區掃描總覽", "All Project Sites Overview");
    }
    const norm = normalizeCanonicalFolderName(rawName, rawZh);
    const lang = typeof window.getAppLanguage === "function" ? window.getAppLanguage() : "zh-TW";
    if (lang === "en") {
      return isLib ? `${norm.en} 3D Model Library` : `${norm.en} Engineering Scan Group`;
    }
    if (isLib) {
      return `${norm.zh} 3D 模型庫`;
    }
    const cleanRawZh = String(rawZh || "")
      .replace(/\s*[\(（][A-Za-z0-9\s&/\-_]+[\)）]\s*/g, "")
      .trim();
    return cleanRawZh || `${norm.zh} 工程掃描群組`;
  }

  function getLibraryScansList() {
    return (STATE.scans || []).filter((s) => isLibraryScan(s));
  }

  function getMapScansOnly(scansList = STATE.scans) {
    return (scansList || []).filter((s) => !isLibraryScan(s));
  }

  function cacheLastViewedMapSiteAndScan(projectGroup, scanId = "") {
    try {
      const scanObj = (STATE.scans || []).find((s) => s.scan_id === scanId);
      if (scanObj && isLibraryScan(scanObj)) return;
      const grp = String(projectGroup || scanObj?.project_group || "").trim();
      if (grp && grp !== "__all__") {
        const libFolders = (STATE.libraryFolders || []).map((f) => String(f.folder_name || "").toLowerCase());
        const normGrp = normalizeCanonicalFolderName(grp).en.toLowerCase();
        if (
          normGrp === "people" ||
          normGrp === "equipment" ||
          normGrp === "general models" ||
          libFolders.includes(grp.toLowerCase()) ||
          libFolders.includes(normGrp)
        ) {
          return;
        }
        localStorage.setItem("gs_last_map_site", grp);
      }
      if (scanObj && !isLibraryScan(scanObj)) {
        localStorage.setItem("gs_last_map_scan_id", String(scanObj.scan_id));
      }
    } catch (_) {}
  }

  function resolveInitialMapSiteAndScan(scansList = STATE.scans) {
    const mapScans = getMapScansOnly(scansList);
    const readyMapScans = mapScans.filter((s) => s.status === "completed");
    const pool = readyMapScans.length > 0 ? readyMapScans : mapScans;
    if (pool.length === 0) {
      const fb = (scansList || [])[0] || null;
      return { scan: fb, projectGroup: fb?.project_group || "" };
    }
    try {
      const cachedScanId = localStorage.getItem("gs_last_map_scan_id") || "";
      const cachedSite = localStorage.getItem("gs_last_map_site") || "";
      if (cachedScanId) {
        const matchedScan = pool.find((s) => s.scan_id === cachedScanId);
        if (matchedScan) {
          return {
            scan: matchedScan,
            projectGroup: matchedScan.project_group || cachedSite || "",
          };
        }
      }
      if (cachedSite) {
        const siteScans = pool.filter((s) => s.project_group === cachedSite);
        if (siteScans.length > 0) {
          return {
            scan: siteScans[0],
            projectGroup: cachedSite,
          };
        }
      }
    } catch (_) {}
    // Default fallback on startup: latest added scan among those on the map (never from library)
    const sortedByLatest = pool.slice().sort((a, b) => {
      const ua = Number(a.uploaded_at || 0);
      const ub = Number(b.uploaded_at || 0);
      if (ua !== ub && ua > 0 && ub > 0) return ub - ua;
      const ca = String(a.capture_date || "");
      const cb = String(b.capture_date || "");
      return cb.localeCompare(ca);
    });
    const latestMapScan = sortedByLatest[0] || pool[0];
    return {
      scan: latestMapScan,
      projectGroup: latestMapScan?.project_group || "",
    };
  }

  function getMapSiteProjectsList() {
    return (STATE.projects || []).filter((p) => p.group_type !== "library");
  }

  function getLibraryFoldersList() {
    const byKey = new Map();
    const addFolder = (name, zh, icon) => {
      const norm = normalizeCanonicalFolderName(name, zh);
      const clean = norm.en;
      if (!clean) return;
      const k = clean.toLowerCase();
      if (!byKey.has(k)) {
        byKey.set(k, {
          folder_name: clean,
          folder_name_zh: norm.zh,
          icon: icon || "folder",
          scan_count: 0,
          scans: [],
        });
      }
    };

    (STATE.libraryFolders || []).forEach((f) => {
      if (f && f.folder_name) addFolder(f.folder_name, f.folder_name_zh, f.icon);
    });
    if (byKey.size === 0) {
      addFolder("People", "人物與角色", "person");
      addFolder("Equipment", "機具與設備", "tool");
      addFolder("General Models", "一般 3D 模型", "cube");
    }

    getLibraryScansList().forEach((s) => {
      const norm = normalizeCanonicalFolderName(s.project_group || "General Models", s.project_name_zh || "");
      s.project_group = norm.en;
      s.project_name_zh = norm.zh;
      addFolder(norm.en, norm.zh, "cube");
      const entry = byKey.get(norm.en.toLowerCase());
      if (entry) {
        entry.scan_count += 1;
        entry.scans.push(s);
      }
    });

    return Array.from(byKey.values());
  }

  function setLeftPaneMode(mode, folderName = null) {
    const nextMode = mode === "library" ? "library" : "map";
    STATE.leftPaneMode = nextMode;
    if (folderName) {
      STATE.selectedLibraryFolder = folderName === "ALL" ? "ALL" : normalizeCanonicalFolderName(folderName).en;
    }

    const navLibBtn = document.getElementById("btnNavLibrary");
    const navMapBtn = document.getElementById("btnNavMap");
    const libOverlay = document.getElementById("modelLibraryOverlay");
    const viewMapEl = document.getElementById("viewMap");
    const mapContainerEl = document.getElementById("mapContainer");
    const mapHudTop = document.querySelector("#viewMap .gs-map-hud-top");
    const mapControlsRail = document.querySelector("#viewMap .gs-map-controls-rail");
    const mapBottomLeftBar = document.querySelector("#viewMap .gs-map-bottom-left-bar");

    if (navLibBtn) navLibBtn.classList.toggle("active", STATE.activeView === "map" && nextMode === "library");
    if (navMapBtn) navMapBtn.classList.toggle("active", STATE.activeView === "map" && nextMode === "map");
    if (viewMapEl) {
      viewMapEl.classList.toggle("gs-library-mode-active", nextMode === "library");
    }
    if (mapContainerEl) {
      mapContainerEl.style.display = nextMode === "library" ? "none" : "";
    }
    if (mapHudTop) {
      mapHudTop.style.display = nextMode === "library" ? "none" : "";
    }
    if (mapControlsRail) {
      mapControlsRail.style.display = nextMode === "library" ? "none" : "";
    }
    if (mapBottomLeftBar) {
      mapBottomLeftBar.style.display = nextMode === "library" ? "none" : "";
    }
    if (libOverlay) {
      libOverlay.style.display = nextMode === "library" ? "flex" : "none";
    }

    renderModelLibraryView();
    if (nextMode === "library") {
      document.getElementById("clusterHoverPopover")?.classList.remove("active");
      const libScans = getLibraryScansList();
      const selFolder = STATE.selectedLibraryFolder || "ALL";
      const targetScan =
        (selFolder !== "ALL"
          ? libScans.find((s) => String(s.project_group || "").toLowerCase() === String(selFolder).toLowerCase())
          : null) || libScans[0];
      if (targetScan && typeof openSiteTimeline === "function") {
        openSiteTimeline(targetScan.project_group, targetScan.scan_id);
      }
    } else {
      // Returning to Map mode: if timeline currently displays a library scan/folder, restore Map Site & Scan
      const curScan = (STATE.scans || []).find((s) => s.scan_id === (STATE.selectedTimelineScanId || STATE.activeScanId));
      if (!curScan || isLibraryScan(curScan)) {
        const mapTarget = resolveInitialMapSiteAndScan(STATE.scans);
        if (mapTarget.scan) {
          STATE.activeScanId = mapTarget.scan.scan_id;
          STATE.selectedTimelineScanId = mapTarget.scan.scan_id;
          STATE.activeProjectGroup = mapTarget.projectGroup;
          populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);
          if (typeof renderMapClusters === "function") renderMapClusters();
          if (typeof openSiteTimeline === "function") {
            openSiteTimeline(STATE.activeProjectGroup, STATE.activeScanId);
          }
        }
      }
    }
  }

  function _getLibraryFolderSvgIcon(iconKey) {
    const k = String(iconKey || "folder").toLowerCase();
    if (k === "person" || k === "🧑" || k === "👤") {
      return `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    }
    if (k === "tool" || k === "🚜" || k === "🛠️") {
      return `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;
    }
    if (k === "cube" || k === "📦" || k === "🧊") {
      return `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`;
    }
    return `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  }

  function renderModelLibraryView() {
    const folders = getLibraryFoldersList();
    const allLibScans = getLibraryScansList();

    const badgeEl = document.getElementById("libraryTotalCountBadge");
    if (badgeEl) badgeEl.textContent = String(allLibScans.length);
    const navBadgeEl = document.getElementById("navLibraryCountBadge");
    if (navBadgeEl) navBadgeEl.textContent = String(allLibScans.length);

    const foldersBar = document.getElementById("libraryFoldersBar");
    const gridEl = document.getElementById("libraryModelsGrid");
    if (!foldersBar || !gridEl) return;

    const info = getCurrentUserRoleInfo();
    const canEdit = Boolean(info.canEditNames && !STATE.isEmbedded);

    const selFolder = STATE.selectedLibraryFolder || "ALL";
    let pillsHtml = `
      <button type="button" class="gs-lib-folder-pill ${selFolder === "ALL" ? "active" : ""}" data-folder="ALL">
        ${_getLibraryFolderSvgIcon("cube")}
        <span>${tr("全部", "All")}</span>
        <span class="gs-lib-folder-count">${allLibScans.length}</span>
      </button>
    `;
    folders.forEach((f) => {
      const isAct = selFolder.toLowerCase() === f.folder_name.toLowerCase();
      const safeName = f.folder_name.replace(/"/g, "&quot;");
      const dispName = escapeHtml(formatGroupDisplayName(f.folder_name, f.folder_name_zh));
      pillsHtml += `
        <button type="button" class="gs-lib-folder-pill ${isAct ? "active" : ""}" data-folder="${safeName}">
          ${_getLibraryFolderSvgIcon(f.icon)}
          <span>${dispName}</span>
          <span class="gs-lib-folder-count">${f.scan_count}</span>
        </button>
      `;
    });
    foldersBar.innerHTML = pillsHtml;

    foldersBar.querySelectorAll(".gs-lib-folder-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        const fname = btn.getAttribute("data-folder") || "ALL";
        STATE.selectedLibraryFolder = fname;
        renderModelLibraryView();
        if (fname !== "ALL") {
          const matchScan = allLibScans.find((s) => String(s.project_group || "").toLowerCase() === fname.toLowerCase());
          if (matchScan && typeof openSiteTimeline === "function") {
            openSiteTimeline(matchScan.project_group, matchScan.scan_id);
          }
        }
      });
    });

    const btnRenFolder = document.getElementById("btnRenameLibraryFolder");
    const btnDelFolder = document.getElementById("btnDeleteLibraryFolder");
    if (btnRenFolder) btnRenFolder.style.display = canEdit && selFolder !== "ALL" ? "inline-flex" : "none";
    if (btnDelFolder) btnDelFolder.style.display = canEdit && selFolder !== "ALL" ? "inline-flex" : "none";

    const q = String(STATE.librarySearchQuery || "").trim().toLowerCase();
    const filteredScans = allLibScans.filter((s) => {
      if (selFolder !== "ALL" && String(s.project_group || "").toLowerCase() !== selFolder.toLowerCase()) {
        return false;
      }
      if (!q) return true;
      return (
        String(s.name || "").toLowerCase().includes(q) ||
        String(s.scan_id || "").toLowerCase().includes(q) ||
        String(s.project_group || "").toLowerCase().includes(q) ||
        String(s.project_name_zh || "").toLowerCase().includes(q)
      );
    });

    if (filteredScans.length === 0) {
      gridEl.innerHTML = `
        <div class="gs-lib-empty-state">
          <div style="margin-bottom:8px;opacity:0.7;">${_getLibraryFolderSvgIcon("cube")}</div>
          <div style="font-weight:700;color:var(--ui-text-primary);margin-bottom:4px;">${tr("此資料夾尚無 3D 模型", "No 3D models in this folder yet")}</div>
          <div style="font-size:12px;color:var(--ui-text-secondary);max-width:360px;">
            ${tr("上傳不含 offset.xyz 的高斯潑濺 (.ply / .splat) 或一般 3D 模型即可自動歸入模型庫，管理員亦可將任何工區掃描移動至此資料夾。", "Upload Gaussian Splats (.ply / .splat) or 3D models without offset.xyz, or use the Move button to move any scan into this folder.")}
          </div>
        </div>
      `;
      return;
    }

    gridEl.innerHTML = filteredScans
      .map((s) => {
        const isGs = Boolean(s.is_gaussian_splat);
        const typeBadge = isGs
          ? `<span class="gs-lib-type-badge gsplat">3DGS</span>`
          : `<span class="gs-lib-type-badge mesh">3D</span>`;
        const metricText = isGs
          ? `${Number(s.splat_count || s.poly_count || 0).toLocaleString()} ${tr("潑濺點", "splats")}`
          : `${Number(s.poly_count || 0).toLocaleString()} ${tr("面", "tris")}`;
        const sizeMb = Number(s.scan_size_mb || (s.size_bytes ? s.size_bytes / (1024 * 1024) : 0)).toFixed(1);
        const isSelected = STATE.selectedTimelineScanId === s.scan_id || STATE.activeScanId === s.scan_id;
        const dispFolder = escapeHtml(formatGroupDisplayName(s.project_group, s.project_name_zh));
        const safeScanName = escapeHtml(s.name || s.scan_id);
        return `
          <div class="gs-lib-card ${isSelected ? "active" : ""}" data-scan-id="${escapeHtml(s.scan_id)}">
            <div class="gs-lib-card-thumb-wrap">
              <img class="gs-lib-card-thumb" data-scan-thumb="${escapeHtml(s.scan_id)}" src="${s.thumbnail_url || `/api/scans/${s.scan_id}/thumbnail`}" alt="${safeScanName}" loading="lazy" />
              ${typeBadge}
              <span class="gs-lib-folder-tag">${dispFolder}</span>
            </div>
            <div class="gs-lib-card-body">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;min-width:0;">
                <div class="gs-lib-card-title" title="${safeScanName}" style="flex:1;min-width:0;">${safeScanName}</div>
                <div class="gs-lib-card-actions" style="margin-top:0;gap:3px;flex-shrink:0;">
                  <button type="button" class="btn-xs js-lib-preview" data-scan-id="${escapeHtml(s.scan_id)}" title="${tr("預覽 3D 模型", "Preview 3D Model")}" aria-label="Preview 3D Model" style="height:22px;width:24px;padding:0;justify-content:center;">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                    </svg>
                  </button>
                  <button type="button" class="btn-xs primary js-lib-studio" data-scan-id="${escapeHtml(s.scan_id)}" title="${tr("於全螢幕 3D 工作坊開啟", "Open in Full 3D Studio")}" aria-label="Open in Full 3D Studio" style="height:22px;width:24px;padding:0;justify-content:center;">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
                    </svg>
                  </button>
                  ${
                    canEdit
                      ? `<button type="button" class="btn-xs js-lib-move" data-scan-id="${escapeHtml(s.scan_id)}" title="${tr("移動至其他模型庫資料夾或地圖工區", "Move to another Library Folder or Map Site")}" aria-label="Move Scan" style="height:22px;width:24px;padding:0;justify-content:center;">
                          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                          </svg>
                        </button>
                        <button type="button" class="btn-xs js-lib-rename" data-scan-id="${escapeHtml(s.scan_id)}" title="${tr("編輯模型名稱", "Edit Model Name")}" aria-label="Edit Model Name" style="height:22px;width:24px;padding:0;justify-content:center;">
                          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                          </svg>
                        </button>
                        <button type="button" class="btn-xs js-lib-delete" data-scan-id="${escapeHtml(s.scan_id)}" title="${tr("移至回收桶", "Move to Recycle Bin")}" aria-label="Delete Model" style="height:22px;width:24px;padding:0;justify-content:center;color:#ef4444;">
                          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                          </svg>
                        </button>`
                      : ""
                  }
                </div>
              </div>
              <div class="gs-lib-card-meta">
                <span>${metricText}</span>
                <span>·</span>
                <span>${sizeMb} MB</span>
                <span>·</span>
                <span>${s.capture_date || ""}</span>
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    gridEl.querySelectorAll(".gs-lib-card").forEach((card) => {
      const sid = card.getAttribute("data-scan-id");
      const scanObj = STATE.scans.find((x) => x.scan_id === sid);
      if (!scanObj) return;
      card.addEventListener("click", (ev) => {
        if (ev.target.closest("button")) return;
        if (typeof openSiteTimeline === "function") {
          openSiteTimeline(scanObj.project_group, scanObj.scan_id);
        }
      });
    });

    gridEl.querySelectorAll(".js-lib-preview").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const sid = btn.getAttribute("data-scan-id");
        const scanObj = STATE.scans.find((x) => x.scan_id === sid);
        if (scanObj && typeof openSiteTimeline === "function") {
          openSiteTimeline(scanObj.project_group, scanObj.scan_id);
        }
      });
    });

    gridEl.querySelectorAll(".js-lib-studio").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const sid = btn.getAttribute("data-scan-id");
        if (sid && typeof switchView === "function") {
          switchView("studio", sid);
        }
      });
    });

    gridEl.querySelectorAll(".js-lib-move").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const sid = btn.getAttribute("data-scan-id");
        if (sid) openMoveScanModal(sid);
      });
    });

    gridEl.querySelectorAll(".js-lib-rename").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const sid = btn.getAttribute("data-scan-id");
        if (sid && typeof openRenameScanModal === "function") openRenameScanModal(sid);
      });
    });

    gridEl.querySelectorAll(".js-lib-delete").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const sid = btn.getAttribute("data-scan-id");
        if (sid && typeof openDeleteScanModal === "function") openDeleteScanModal(sid);
      });
    });
  }

  function _populateMoveScanTargetDropdown(targetType, currentGroup = "") {
    const sel = document.getElementById("moveScanTargetSelect");
    const newWrap = document.getElementById("moveScanNewGroupWrap");
    const modal = document.getElementById("moveScanModal");
    if (modal) modal.dataset.targetType = targetType === "site" ? "site" : "library";
    const typeLibBtn = document.getElementById("moveScanTypeLibrary");
    const typeSiteBtn = document.getElementById("moveScanTypeSite");
    if (typeLibBtn) {
      typeLibBtn.classList.toggle("active", targetType !== "site");
      typeLibBtn.classList.toggle("primary", targetType !== "site");
    }
    if (typeSiteBtn) {
      typeSiteBtn.classList.toggle("active", targetType === "site");
      typeSiteBtn.classList.toggle("primary", targetType === "site");
    }
    if (!sel) return;

    let options = [];
    if (targetType === "library") {
      const folders = getLibraryFoldersList();
      options = folders.map((f) => ({
        value: f.folder_name,
        label: `${formatGroupDisplayName(f.folder_name, f.folder_name_zh)} (${f.scan_count})`,
      }));
    } else {
      const sites = getProjectGroupsList("", { includeLibrary: false });
      options = sites.map((p) => ({
        value: p.project_group,
        label: `${formatGroupDisplayName(p.project_group, p.project_name_zh)} (${p.scans?.length || p.scan_count || 0})`,
      }));
    }

    let html = options
      .map((o) => {
        const safeVal = String(o.value).replace(/"/g, "&quot;");
        const isSel = String(o.value).toLowerCase() === String(currentGroup || "").toLowerCase();
        return `<option value="${safeVal}" ${isSel ? "selected" : ""}>${escapeHtml(o.label)}</option>`;
      })
      .join("");
    html += `<option value="__NEW__">＋ ${
      targetType === "library"
        ? tr("建立新模型庫資料夾...", "Create New Library Folder...")
        : tr("建立新地圖工區...", "Create New Map Site...")
    }</option>`;
    sel.innerHTML = html;
    if (newWrap) {
      newWrap.style.display = sel.value === "__NEW__" || sel.value === "__new__" ? "block" : "none";
    }
  }

  function openMoveScanModal(scanId, { preserveTargetType = false } = {}) {
    const scan =
      STATE.scans.find((s) => s.scan_id === scanId) ||
      STATE.activeScan ||
      STATE.scans.find((s) => s.scan_id === STATE.selectedTimelineScanId);
    if (!scan) return;

    const modal = document.getElementById("moveScanModal");
    if (!modal) return;
    modal.dataset.scanId = scan.scan_id;

    const nameEl = document.getElementById("moveScanCurrentName");
    if (nameEl) {
      nameEl.textContent = `${scan.name} (${formatGroupDisplayName(scan.project_group, scan.project_name_zh)})`;
    }

    const curType =
      preserveTargetType && modal.dataset.targetType
        ? modal.dataset.targetType
        : isLibraryScan(scan)
          ? "library"
          : "site";
    const sel = document.getElementById("moveScanTargetSelect");
    const prevSelVal = preserveTargetType && sel ? sel.value : scan.project_group;
    const newInp = document.getElementById("moveScanNewGroupInput");
    if (newInp && !preserveTargetType) newInp.value = "";

    _populateMoveScanTargetDropdown(curType, prevSelVal);
    modal.style.display = "";
    modal.classList.add("active");
  }

  async function submitMoveScanModal() {
    const modal = document.getElementById("moveScanModal");
    const scanId = modal?.dataset?.scanId;
    if (!scanId) return;

    const targetType = modal?.dataset?.targetType === "site" ? "site" : "library";
    const sel = document.getElementById("moveScanTargetSelect");
    const newInp = document.getElementById("moveScanNewGroupInput");

    let targetGroup = sel ? sel.value : "";
    if (targetGroup === "__NEW__" || targetGroup === "__new__") {
      targetGroup = String(newInp?.value || "").trim();
    }
    if (!targetGroup) {
      if (typeof showToast === "function") {
        showToast(tr("請輸入或選擇目標資料夾 / 工區名稱", "Please select or enter a target folder / site name"), "warning");
      }
      return;
    }

    const submitBtn = document.getElementById("btnConfirmMoveScan");
    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await apiPost("/api/scans/move", {
        scan_id: scanId,
        target_group: targetGroup,
        target_type: targetType,
      });
      if (Array.isArray(res.scans)) STATE.scans = res.scans;
      if (Array.isArray(res.projects)) STATE.projects = res.projects;
      if (Array.isArray(res.library_folders)) STATE.libraryFolders = res.library_folders;

      const updatedScan = STATE.scans.find((s) => s.scan_id === scanId);
      if (updatedScan && STATE.activeScanId === scanId) {
        STATE.activeScan = updatedScan;
      }
      const finalGroup = updatedScan?.project_group || targetGroup;
      STATE.activeProjectGroup = finalGroup;
      if (targetType === "library") {
        STATE.selectedLibraryFolder = finalGroup;
      } else {
        cacheLastViewedMapSiteAndScan(finalGroup, scanId);
      }

      if (modal) {
        modal.classList.remove("active");
        modal.classList.remove("active");
      modal.style.display = "";
      }
      populateProjectScanDropdowns(finalGroup, scanId);
      if (typeof renderMapClusters === "function") renderMapClusters();
      renderModelLibraryView();
      if (typeof openSiteTimeline === "function") {
        openSiteTimeline(finalGroup, scanId);
      }
      if (typeof showToast === "function") {
        const dispTarget = formatGroupDisplayName(finalGroup, updatedScan?.project_name_zh || "");
        showToast(
          tr(
            `已將「${updatedScan?.name || scanId}」移動至${targetType === "library" ? "模型庫資料夾" : "地圖工區"}「${dispTarget}」`,
            `Moved "${updatedScan?.name || scanId}" to ${targetType === "library" ? "Library Folder" : "Map Site"} "${dispTarget}"`
          ),
          "success"
        );
      }
    } catch (err) {
      if (typeof showToast === "function") {
        showToast(err.message || "Failed to move scan", "error");
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  function openLibraryFolderModal(mode = "create", { preserveInput = false } = {}) {
    const modal = document.getElementById("libraryFolderModal");
    if (!modal) return;
    modal.dataset.mode = mode;
    const titleEl = document.getElementById("libraryFolderModalTitle");
    const inpName = document.getElementById("libraryFolderNameInput");
    const inpIcon = document.getElementById("libraryFolderIconSelect");

    if (mode === "rename" && STATE.selectedLibraryFolder && STATE.selectedLibraryFolder !== "ALL") {
      const curName = STATE.selectedLibraryFolder;
      modal.dataset.oldName = curName;
      if (titleEl) titleEl.textContent = tr("重新命名模型庫資料夾", "Rename Library Folder");
      if (inpName && !preserveInput) inpName.value = formatGroupDisplayName(curName);
      const curObj = getLibraryFoldersList().find((f) => f.folder_name.toLowerCase() === curName.toLowerCase());
      if (inpIcon && curObj && !preserveInput) inpIcon.value = curObj.icon || "folder";
    } else {
      modal.dataset.oldName = "";
      if (titleEl) titleEl.textContent = tr("新增 3D 模型庫資料夾", "New 3D Library Folder");
      if (inpName && !preserveInput) inpName.value = "";
      if (inpIcon && !preserveInput) inpIcon.value = "cube";
    }
    modal.style.display = "";
    modal.classList.add("active");
    if (!preserveInput) setTimeout(() => inpName?.focus(), 40);
  }

  async function submitLibraryFolderModal() {
    const modal = document.getElementById("libraryFolderModal");
    if (!modal) return;
    const mode = modal.dataset.mode || "create";
    const oldName = modal.dataset.oldName || "";
    const inpName = document.getElementById("libraryFolderNameInput");
    const inpIcon = document.getElementById("libraryFolderIconSelect");
    const newName = String(inpName?.value || "").trim();
    const icon = String(inpIcon?.value || "folder").trim();
    if (!newName) return;

    const btn = document.getElementById("btnConfirmLibraryFolder");
    if (btn) btn.disabled = true;
    try {
      const payload =
        mode === "rename"
          ? { action: "rename", old_folder_name: oldName, new_folder_name: newName, icon }
          : { action: "create", folder_name: newName, icon };
      const res = await apiPost("/api/library/folders", payload);
      if (Array.isArray(res.library_folders)) STATE.libraryFolders = res.library_folders;
      if (Array.isArray(res.projects)) STATE.projects = res.projects;
      if (Array.isArray(res.scans)) STATE.scans = res.scans;
      const norm = normalizeCanonicalFolderName(newName);
      STATE.selectedLibraryFolder = norm.en;
      modal.classList.remove("active");
      modal.style.display = "";
      renderModelLibraryView();
      populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);
      if (typeof renderMapClusters === "function") renderMapClusters();
      if (typeof showToast === "function") {
        const disp = formatGroupDisplayName(norm.en, norm.zh);
        showToast(
          mode === "rename"
            ? tr(`已重新命名資料夾為「${disp}」`, `Renamed folder to "${disp}"`)
            : tr(`已建立模型庫資料夾「${disp}」`, `Created library folder "${disp}"`),
          "success"
        );
      }
    } catch (err) {
      if (typeof showToast === "function") showToast(err.message || "Folder operation failed", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function deleteActiveLibraryFolder() {
    const cur = STATE.selectedLibraryFolder;
    if (!cur || cur === "ALL") return;
    try {
      const disp = formatGroupDisplayName(cur);
      const res = await apiPost("/api/library/folders", {
        action: "delete",
        folder_name: cur,
      });
      if (Array.isArray(res.library_folders)) STATE.libraryFolders = res.library_folders;
      if (Array.isArray(res.projects)) STATE.projects = res.projects;
      if (Array.isArray(res.scans)) STATE.scans = res.scans;
      STATE.selectedLibraryFolder = "ALL";
      renderModelLibraryView();
      populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);
      if (typeof renderMapClusters === "function") renderMapClusters();
      if (typeof showToast === "function") {
        showToast(tr(`已刪除資料夾「${disp}」`, `Deleted folder "${disp}"`), "info");
      }
    } catch (err) {
      if (typeof showToast === "function") showToast(err.message || "Failed to delete folder", "error");
    }
  }

  window.isLibraryScan = isLibraryScan;
  window.normalizeCanonicalFolderName = normalizeCanonicalFolderName;
  window.formatGroupDisplayName = formatGroupDisplayName;
  window.formatGroupSubtitleDisplay = formatGroupSubtitleDisplay;
  window.getLibraryScansList = getLibraryScansList;
  window.getMapScansOnly = getMapScansOnly;
  window.cacheLastViewedMapSiteAndScan = cacheLastViewedMapSiteAndScan;
  window.resolveInitialMapSiteAndScan = resolveInitialMapSiteAndScan;
  window.getLibraryFoldersList = getLibraryFoldersList;
  window.setLeftPaneMode = setLeftPaneMode;
  window.renderModelLibraryView = renderModelLibraryView;
  window._populateMoveScanTargetDropdown = _populateMoveScanTargetDropdown;
  window.openMoveScanModal = openMoveScanModal;
  window.submitMoveScanModal = submitMoveScanModal;
  window.openLibraryFolderModal = openLibraryFolderModal;
  window.submitLibraryFolderModal = submitLibraryFolderModal;
  window.deleteActiveLibraryFolder = deleteActiveLibraryFolder;
  window.isScanOrTilesetGaussianSplat = isScanOrTilesetGaussianSplat;
  window.loadGaussianSplatIntoContext = loadGaussianSplatIntoContext;
  window.updateGaussianSplatForContext = updateGaussianSplatForContext;
  window.disposeGaussianSplatFromContext = disposeGaussianSplatFromContext;



