/**
 * GatheringScans (scans.gatheren.cloud) — Frontend Studio Application
 * Implements:
 * 1. Geospatial Map Overview with Spatial Clustering & Hover Selection Popover
 * 2. 3D Scan Studio (Three.js + 3d-tiles-renderer + KTX2 + TWD97/TWVD2001)
 * 3. GatheringCloud-styled Measurement & Civil Surveying Toolbar:
 *    - Distance (3D, Horiz, Δh), Angle, Area (m² & 坪), Coordinates, Laser
 *    - Cut/Fill Volume & Material Stockpile Report Generator (PDF/HTML & Excel CSV)
 *    - Live 3D Elevation Contours & AutoCAD .DWG / .DXF Export (TWD97 + TWVD2001)
 *    - 2D Cross-Section Elevation Profile Graph
 *    - RTK Raw Camera Photo Pin Inspector
 *    - Section Box Clipping, 3D Geo-Comments, and GC_ScanOptimizer PC Action Drawer
 * 4. Multi-Date Side-by-Side Split Curtain Slider + ΔZ Change Detection Heatmap
 * 5. Scoped External Share Link Controls (/s/<token>) with Instant Revocation
 * 6. Client-Side Browser Offline Cache (CacheStorage + IndexedDB, 0B on Linux VPS)
 */

(function () {
  "use strict";

  // Polyfill Object3D.removeFromParent if needed
  if (window.THREE && window.THREE.Object3D && !window.THREE.Object3D.prototype.removeFromParent) {
    window.THREE.Object3D.prototype.removeFromParent = function () {
      if (this.parent !== null) this.parent.remove(this);
      return this;
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
    window.DEFAULT_GOOGLE_MAPS_API_KEY || "AIzaSyBhHW138sGKgzKHDOTvv4RePukr_q2VbqQ";

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

  const initialShareToken = new URLSearchParams(window.location.search).get("share") || "";
  const initialUser = getInitialCurrentUser();

  // Application State
  const STATE = {
    activeView: "map",
    scans: [],
    projects: [],
    materials: {},
    activeScanId: "",
    activeScan: null,
    activeProjectGroup: "",
    projectFilterQuery: "",
    siteTimelineOpen: false,
    selectedTimelineScanId: "",
    capturedThumbs: new Set(),
    scanBrightness: 1.0,
    mapLyrs: "y", // 'y' = Google Satellite Hybrid, 'm' = Google Roadmap
    activeTool: "distance",
    snapEnabled: true,
    pcOnline: true,
    shareToken: initialShareToken,
    shareLinkInfo: null,
    currentUser: initialUser,
    isAuthorized: Boolean(initialUser && initialUser.email) || Boolean(initialShareToken),
    themePreference: localStorage.getItem("gs_theme_pref") || "auto",
    resolvedTheme: "light",
    teamProfiles: [],
    cachedScanIds: new Set(JSON.parse(localStorage.getItem("gs_cached_scans") || "[]")),
    measurePoints: [],
    maskBoundaryPoints: [],
    cropMode: "delete_inside",
    lassoInputMethod: "lasso",
    lassoVisibleOnlyDelete: true,
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
  };

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
        ? `Filtered Projects (${filteredGroups.length} / ${allGroups.length} Sites)`
        : `All Projects (${allGroups.length} Site${allGroups.length === 1 ? "" : "s"} · ${STATE.scans.length} Scans)`;
      mapProjSel.appendChild(allOpt);

      filteredGroups.forEach((grp) => {
        const opt = document.createElement("option");
        opt.value = grp.project_group;
        opt.textContent = `${grp.project_group} (${grp.scans.length} Scan${grp.scans.length === 1 ? "" : "s"})`;
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
        allOpt.textContent = `All Projects (${allGroups.length} Sites · ${STATE.scans.length})`;
        sel.appendChild(allOpt);
      }
      allGroups.forEach((grp) => {
        const opt = document.createElement("option");
        opt.value = grp.project_group;
        opt.textContent = `${grp.project_group} (${grp.scans.length})`;
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

    [studioSel, cmpLeft, cmpRight].forEach((sel) => {
      if (!sel) return;
      const prevVal = sel.value;
      sel.innerHTML = "";
      projectScans.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.scan_id;
        opt.textContent = `${s.name} (${s.capture_date || ""})`;
        sel.appendChild(opt);
      });
      if (preferredScanId && projectScans.some((s) => s.scan_id === preferredScanId)) {
        sel.value = preferredScanId;
      } else if (prevVal && projectScans.some((s) => s.scan_id === prevVal)) {
        sel.value = prevVal;
      } else if (projectScans.length > 0) {
        sel.value = projectScans[0].scan_id;
      }
    });

    if (cmpLeft && cmpRight && projectScans.length >= 2 && cmpLeft.value === cmpRight.value) {
      cmpLeft.value = projectScans[1].scan_id;
      cmpRight.value = projectScans[0].scan_id;
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

  function showToast(msg, durationMs = 3400) {
    const el = document.getElementById("gsToast");
    if (!el) return;
    el.textContent = msg;
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
        const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
        if (gl) {
          const dbg = gl.getExtension("WEBGL_debug_renderer_info");
          gpuRenderer = dbg
            ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "")
            : String(gl.getParameter(gl.RENDERER) || "");
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
      return {
        token: STATE.shareToken,
        session_id: sessionId,
        visitor_id: visitorId,
        viewer_name: getViewerName(),
        viewer_email: getViewerEmail(),
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
    owner: "Owner (System Owner)",
    admin: "Admin (Manage Users & Workflows)",
    editor: "Editor (Edit Names & Run Scans)",
    viewer: "Viewer (View All & Measure)",
    guest: "Guest (Read-Only · Basic Tools)",
  };

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

  function applyRolePermissionsToUI() {
    const info = getCurrentUserRoleInfo();
    const setDisp = (id, show, disp = "") => {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? disp : "none";
    };

    // 1. Rename Site, Rename Scan & Delete Scan buttons (Editor, Admin, Owner only)
    [
      "btnRenameMapSite",
      "btnRenamePopoverSite",
      "btnRenameTimelineSite",
      "btnRenameStudioSite",
      "btnRenamePreviewScan",
      "btnRenameStudioScan",
      "btnDeletePreviewScan",
      "btnDeleteStudioScan",
    ].forEach((id) => setDisp(id, info.canEditNames, "inline-flex"));
    document.querySelectorAll(".gs-tile-edit-actions").forEach((el) => {
      el.style.display = info.canEditNames ? "flex" : "none";
    });

    // 2. Re-run Scan & Scan Editing Dock / Lasso Delete / Crop / Align & Merge / Optimizer / Queue buttons (Editor, Admin, Owner only; hidden for Viewer & Guest)
    setDisp("studioEditingDock", info.canRunWorkflows, "flex");
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

    // 5. Basic measurement tools (Distance, Area, Coordinates, Snap, Clear) honor allowMeasurements
    [
      "btnMeasureDistance",
      "btnMeasureArea",
      "btnMeasureCoordinates",
      "btnMeasureCoords",
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

    // 6. Advanced surveying tools hidden for Guest role (Viewer+ gets full surveying suite)
    const showAdvancedSurvey = !info.isGuestRole && info.allowMeasurements;
    [
      "btnMeasureAngle",
      "btnMeasureLaser",
      "btnMeasureVolume",
      "btnMeasureContours",
      "btnMeasureProfile",
      "btnMeasurePhotos",
      "btnDockCategorize",
      "btnDockVolume",
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
      dockDividers[0].style.display = showAdvancedSurvey ? "" : "none";
      dockDividers[1].style.display = info.allowMeasurements && (showAdvancedSurvey || info.allowComments) ? "" : "none";
      dockDividers[2].style.display = info.allowComments || info.allowMeasurements ? "" : "none";
    }

    // 8. If current active Studio tool is no longer permitted after role change, reset cleanly
    const advTools = new Set(["angle", "laser", "volume", "contours", "profile", "section", "photos", "categorize"]);
    const wfTools = new Set(["optimizer", "crs", "generate_scan", "crop", "crop_delete", "align_merge"]);
    if (!info.canRunWorkflows && STATE.multiAlign?.active && typeof exitMultiScanAlignMode === "function") {
      exitMultiScanAlignMode(true);
    }
    if (
      (!showAdvancedSurvey && advTools.has(STATE.activeTool)) ||
      (!info.canRunWorkflows && wfTools.has(STATE.activeTool)) ||
      (!info.allowComments && STATE.activeTool === "comments") ||
      (!info.allowMeasurements && ["distance", "area", "coordinates"].includes(STATE.activeTool))
    ) {
      STATE.activeTool = info.allowMeasurements ? "distance" : "orbit";
      document.getElementById("studioSidePanel")?.classList.remove("active");
    }

    if (typeof syncMultiAlignToolAvailability === "function") {
      syncMultiAlignToolAvailability();
    }

    // Role badge in Settings Admin Control Panel
    const badgeRole = document.getElementById("badgeCurrentUserRoleLevel") || document.getElementById("adminCurrentUserRolePill");
    if (badgeRole) {
      badgeRole.textContent = `Active Role: L${info.level} — ${info.label}`;
    }
    const adminForm = document.getElementById("adminUserEditorForm");
    if (adminForm) {
      adminForm.style.display = info.canManageUsers ? "grid" : "none";
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
    const res = await fetch(fullUrl, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (url.startsWith("/api/survey/") && !body?.only_update_filters) {
      SHARE_TELEMETRY.recordMeasurement(url.replace("/api/survey/", "survey_"));
    }
    return data;
  }

  // Register Client-Side Offline Service Worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[GatheringScans] ServiceWorker registration note:", err);
    });
  }

  // ============================================================================
  // 1. GOOGLE MAPS OVERVIEW & SPATIAL CLUSTERING (Requirement 4.a & Fix #3)
  // ============================================================================
  let gsMap = null;

  function latLonToNormMercator(lat, lon) {
    const u = (lon + 180) / 360;
    const sinLat = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
    const v = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    return { u, v };
  }

  function normMercatorToLatLon(u, v) {
    const lon = u * 360 - 180;
    const n = Math.PI - 2 * Math.PI * v;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, lon };
  }

  function fitMapToAllGeorefGroups(targetGroups = null) {
    if (!gsMap) return;
    const groups = (targetGroups || getProjectGroupsList("")).filter(
      (g) => g && g.hasGeoref && Number.isFinite(g.lat) && Number.isFinite(g.lon)
    );
    if (groups.length === 0) {
      gsMap.centerLat = 0;
      gsMap.centerLon = 0;
      gsMap.zoom = 2.0;
      return;
    }
    if (groups.length === 1) {
      gsMap.centerLat = groups[0].lat;
      gsMap.centerLon = groups[0].lon;
      gsMap.zoom = 14.5;
      return;
    }
    let minLat = Infinity,
      maxLat = -Infinity,
      minLon = Infinity,
      maxLon = -Infinity;
    groups.forEach((g) => {
      if (g.lat < minLat) minLat = g.lat;
      if (g.lat > maxLat) maxLat = g.lat;
      if (g.lon < minLon) minLon = g.lon;
      if (g.lon > maxLon) maxLon = g.lon;
    });
    gsMap.centerLat = (minLat + maxLat) * 0.5;
    gsMap.centerLon = (minLon + maxLon) * 0.5;
    const pMin = latLonToNormMercator(maxLat, minLon);
    const pMax = latLonToNormMercator(minLat, maxLon);
    const du = Math.abs(pMax.u - pMin.u);
    const dv = Math.abs(pMax.v - pMin.v);
    const w = Math.max(320, gsMap.container?.clientWidth || 840);
    const h = Math.max(240, gsMap.container?.clientHeight || 640);
    const zX = du > 1e-9 ? Math.log2((w * 0.68) / (256 * du)) : 14.5;
    const zY = dv > 1e-9 ? Math.log2((h * 0.68) / (256 * dv)) : 14.5;
    gsMap.zoom = Math.max(2.0, Math.min(15.0, Math.min(zX, zY)));
  }

  function initMap() {
    const container = document.getElementById("mapContainer");
    if (!container || gsMap) return;

    container.style.position = "relative";
    container.style.overflow = "hidden";
    container.style.touchAction = "none";
    container.style.userSelect = "none";
    container.style.webkitUserSelect = "none";

    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.touchAction = "none";
    canvas.style.cursor = "grab";
    container.appendChild(canvas);

    const markerLayer = document.createElement("div");
    markerLayer.style.position = "absolute";
    markerLayer.style.inset = "0";
    markerLayer.style.pointerEvents = "none";
    markerLayer.style.touchAction = "none";
    container.appendChild(markerLayer);

    // Google Maps attribution badge (bottom-left)
    const gAttr = document.createElement("div");
    gAttr.style.cssText =
      "position:absolute;bottom:10px;left:14px;background:var(--ui-bg-window);border:1px solid var(--ui-border-strong);border-radius:6px;padding:3px 9px;font-size:11px;font-weight:600;color:var(--ui-text-primary);z-index:400;pointer-events:none;box-shadow:var(--ui-shadow-hud);";
    gAttr.textContent = "Google Maps · TWD97 (121) + TWVD2001";
    container.appendChild(gAttr);

    // Touch-friendly Map Zoom & Reset Controls (bottom-right)
    const zoomCtrl = document.createElement("div");
    zoomCtrl.className = "gs-map-zoom-controls";
    zoomCtrl.innerHTML = `
      <button type="button" class="gs-map-zoom-btn" id="btnMapZoomIn" title="Zoom In" aria-label="Zoom In">+</button>
      <button type="button" class="gs-map-zoom-btn" id="btnMapZoomOut" title="Zoom Out" aria-label="Zoom Out">−</button>
      <button type="button" class="gs-map-zoom-btn" id="btnMapResetView" title="Fit All Scan Sites" aria-label="Fit All Scan Sites">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      </button>
    `;
    container.appendChild(zoomCtrl);

    gsMap = {
      container,
      canvas,
      ctx: canvas.getContext("2d"),
      markerLayer,
      centerLat: 0,
      centerLon: 0,
      zoom: 2.0,
      _initialFitDone: false,
      groups: [],
      tileCache: new Map(),
      dragging: false,
      dragMovedPx: 0,
      lastX: 0,
      lastY: 0,
      activePointers: new Map(),
      pinchPrevDist: 0,
      pinchPrevMid: null,
      lastTouchHandledAt: 0,
    };

    const projectLatLon = (lat, lon) => {
      const w = canvas.width || container.clientWidth || 1280;
      const h = canvas.height || container.clientHeight || 800;
      const worldPx = 256 * Math.pow(2, gsMap.zoom);
      const c = latLonToNormMercator(gsMap.centerLat, gsMap.centerLon);
      const p = latLonToNormMercator(lat, lon);
      const x = w * 0.50 + (p.u - c.u) * worldPx;
      const y = h * 0.50 + (p.v - c.v) * worldPx;
      return { x, y };
    };

    const unprojectXY = (x, y) => {
      const w = canvas.width || container.clientWidth || 1280;
      const h = canvas.height || container.clientHeight || 800;
      const worldPx = 256 * Math.pow(2, gsMap.zoom);
      const c = latLonToNormMercator(gsMap.centerLat, gsMap.centerLon);
      const u = c.u + (x - w * 0.50) / worldPx;
      const v = c.v + (y - h * 0.50) / worldPx;
      return normMercatorToLatLon(u, v);
    };

    gsMap.projectLatLon = projectLatLon;
    gsMap.unprojectXY = unprojectXY;

    const getGoogleTileImage = (lyrs, z, tx, ty) => {
      const maxTile = 1 << z;
      if (ty < 0 || ty >= maxTile) return null;
      const wrappedTx = ((tx % maxTile) + maxTile) % maxTile;
      const cacheKey = `${lyrs}_${z}_${wrappedTx}_${ty}`;
      if (gsMap.tileCache.has(cacheKey)) {
        return gsMap.tileCache.get(cacheKey);
      }
      const sub = (wrappedTx + ty) & 3;
      const apiKey = encodeURIComponent(DEFAULT_GOOGLE_MAPS_API_KEY);
      const img = new Image();
      img.crossOrigin = "anonymous";
      const entry = { img, loaded: false };
      gsMap.tileCache.set(cacheKey, entry);
      img.onload = () => {
        entry.loaded = true;
        if (gsMap && gsMap.drawMap) gsMap.drawMap();
      };
      img.onerror = () => {
        if (!entry._retriedKeyless) {
          entry._retriedKeyless = true;
          img.src = `https://mt${sub}.google.com/vt/lyrs=${lyrs}&hl=zh-TW&x=${wrappedTx}&y=${ty}&z=${z}`;
        }
      };
      img.src = `https://mt${sub}.google.com/vt/lyrs=${lyrs}&hl=zh-TW&x=${wrappedTx}&y=${ty}&z=${z}&key=${apiKey}`;
      return entry;
    };

    const updateCursorCoordsHud = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      const { lat, lon } = unprojectXY(clientX - rect.left, clientY - rect.top);
      const coordEl = document.getElementById("mapCursorCoords");
      if (!coordEl) return;
      if (lat >= 21.5 && lat <= 26.5 && lon >= 119.8 && lon <= 122.3) {
        const tm = wgs84ToTransverseMercatorJS(lat, lon, 121.0, 250000.0, 0.9999, 298.257222101);
        coordEl.textContent = `TWD97(121) E: ${tm.e.toFixed(1)}m | N: ${tm.n.toFixed(1)}m | WGS84: ${lat.toFixed(5)}°N, ${lon.toFixed(5)}°E`;
      } else if (lat >= 21.5 && lat <= 26.5 && lon >= 118.0 && lon < 119.8) {
        const tm = wgs84ToTransverseMercatorJS(lat, lon, 119.0, 250000.0, 0.9999, 298.257222101);
        coordEl.textContent = `TWD97(119) E: ${tm.e.toFixed(1)}m | N: ${tm.n.toFixed(1)}m | WGS84: ${lat.toFixed(5)}°N, ${lon.toFixed(5)}°E`;
      } else if (Math.abs(lat) <= 84.0) {
        const zone = Math.max(1, Math.min(60, Math.floor((lon + 180.0) / 6.0) + 1));
        const lon0 = (zone - 1) * 6.0 - 180.0 + 3.0;
        const utm = wgs84ToTransverseMercatorJS(lat, lon, lon0, 500000.0, 0.9996, 298.257223563);
        const uN = lat < 0 ? utm.n + 10000000.0 : utm.n;
        const hemi = lat >= 0 ? "N" : "S";
        coordEl.textContent = `UTM ${zone}${hemi} E: ${utm.e.toFixed(1)}m | N: ${uN.toFixed(1)}m | WGS84: ${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;
      } else {
        coordEl.textContent = `WGS84: ${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;
      }
    };

    const panByPixels = (dx, dy) => {
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return;
      const worldPx = 256 * Math.pow(2, gsMap.zoom);
      const c = latLonToNormMercator(gsMap.centerLat, gsMap.centerLon);
      const next = normMercatorToLatLon(c.u - dx / worldPx, c.v - dy / worldPx);
      gsMap.centerLat = Math.max(-80.0, Math.min(80.0, next.lat));
      gsMap.centerLon = Math.max(-179.9, Math.min(179.9, next.lon));
      drawMap();
    };

    const zoomAroundClientPoint = (nextZoom, clientX, clientY) => {
      const clampedZoom = Math.max(2.0, Math.min(19.0, nextZoom));
      if (Math.abs(clampedZoom - gsMap.zoom) < 1e-4) return;
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const w = canvas.width || container.clientWidth || 1280;
      const h = canvas.height || container.clientHeight || 800;
      const anchorWorldBefore = 256 * Math.pow(2, gsMap.zoom);
      const cBefore = latLonToNormMercator(gsMap.centerLat, gsMap.centerLon);
      const anchorU = cBefore.u + (px - w * 0.50) / anchorWorldBefore;
      const anchorV = cBefore.v + (py - h * 0.50) / anchorWorldBefore;

      gsMap.zoom = clampedZoom;
      const anchorWorldAfter = 256 * Math.pow(2, gsMap.zoom);
      const nextCenterU = anchorU - (px - w * 0.50) / anchorWorldAfter;
      const nextCenterV = anchorV - (py - h * 0.50) / anchorWorldAfter;
      const nextCenter = normMercatorToLatLon(nextCenterU, nextCenterV);
      gsMap.centerLat = Math.max(-80.0, Math.min(80.0, nextCenter.lat));
      gsMap.centerLon = Math.max(-179.9, Math.min(179.9, nextCenter.lon));
      drawMap();
    };

    const drawMap = () => {
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = gsMap.ctx;

      // Base fill while Google tiles stream
      ctx.fillStyle = STATE.mapLyrs === "m" ? "#e2e8f0" : "#0b1726";
      ctx.fillRect(0, 0, w, h);

      // Render Web Mercator Google Maps Tiles (Satellite Hybrid 'y' or Roadmap 'm')
      const zInt = Math.max(2, Math.min(19, Math.round(gsMap.zoom)));
      const numTiles = 1 << zInt;
      const tileScale = 256 * Math.pow(2, gsMap.zoom - zInt);
      const cNorm = latLonToNormMercator(gsMap.centerLat, gsMap.centerLon);
      const centerTx = cNorm.u * numTiles;
      const centerTy = cNorm.v * numTiles;
      const centerX = w * 0.50;
      const centerY = h * 0.50;

      const minTx = Math.floor(centerTx - centerX / tileScale) - 1;
      const maxTx = Math.ceil(centerTx + (w - centerX) / tileScale) + 1;
      const minTy = Math.floor(centerTy - centerY / tileScale) - 1;
      const maxTy = Math.ceil(centerTy + (h - centerY) / tileScale) + 1;

      for (let ty = minTy; ty <= maxTy; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
          const px = centerX + (tx - centerTx) * tileScale;
          const py = centerY + (ty - centerTy) * tileScale;
          const tileEntry = getGoogleTileImage(STATE.mapLyrs, zInt, tx, ty);
          if (tileEntry && tileEntry.loaded) {
            ctx.drawImage(tileEntry.img, Math.floor(px), Math.floor(py), Math.ceil(tileScale) + 1, Math.ceil(tileScale) + 1);
          } else if (zInt > 10) {
            // Fallback parent tile while zooming
            const pZ = zInt - 1;
            const pEntry = gsMap.tileCache.get(`${STATE.mapLyrs}_${pZ}_${tx >> 1}_${ty >> 1}`);
            if (pEntry && pEntry.loaded) {
              const sx = (tx & 1) * 128;
              const sy = (ty & 1) * 128;
              ctx.drawImage(pEntry.img, sx, sy, 128, 128, Math.floor(px), Math.floor(py), Math.ceil(tileScale) + 1, Math.ceil(tileScale) + 1);
            }
          }
        }
      }

      // Dynamic Viewport Coordinate Grid Overlay (Zero Hardcoded Lat/Lon Bounds)
      ctx.strokeStyle = STATE.mapLyrs === "m" ? "rgba(2, 132, 199, 0.16)" : "rgba(56, 189, 248, 0.18)";
      ctx.lineWidth = 1;
      ctx.fillStyle = STATE.mapLyrs === "m" ? "rgba(15, 23, 42, 0.72)" : "rgba(248, 250, 252, 0.80)";
      ctx.font = "600 10px Consolas, monospace";

      const nw = unprojectXY(0, 0);
      const se = unprojectXY(w, h);
      const viewMinLon = Math.max(-180, Math.min(nw.lon, se.lon));
      const viewMaxLon = Math.min(180, Math.max(nw.lon, se.lon));
      const viewMinLat = Math.max(-85, Math.min(nw.lat, se.lat));
      const viewMaxLat = Math.min(85, Math.max(nw.lat, se.lat));
      const gridStep =
        gsMap.zoom >= 15 ? 0.005 : gsMap.zoom >= 13 ? 0.02 : gsMap.zoom >= 10 ? 0.05 : gsMap.zoom >= 7 ? 0.5 : 10.0;

      const startLon = Math.floor(viewMinLon / gridStep) * gridStep;
      for (let lon = startLon, n = 0; lon <= viewMaxLon + gridStep && n < 40; lon += gridStep, n++) {
        const p = projectLatLon(gsMap.centerLat, lon);
        ctx.beginPath();
        ctx.moveTo(p.x, 0);
        ctx.lineTo(p.x, h);
        ctx.stroke();
        const isTm2 = gsMap.centerLat >= 21.5 && gsMap.centerLat <= 26.5 && lon >= 118.0 && lon <= 122.3;
        let lbl;
        if (isTm2) {
          const lon0 = lon < 119.8 ? 119.0 : 121.0;
          const tm = wgs84ToTransverseMercatorJS(gsMap.centerLat, lon, lon0, 250000.0, 0.9999, 298.257222101);
          lbl = `E:${Math.round(tm.e)}m`;
        } else {
          lbl = `${lon.toFixed(gsMap.zoom >= 13 ? 3 : 2)}°`;
        }
        ctx.fillText(lbl, p.x + 4, h - 12);
      }
      const startLat = Math.floor(viewMinLat / gridStep) * gridStep;
      for (let lat = startLat, n = 0; lat <= viewMaxLat + gridStep && n < 40; lat += gridStep, n++) {
        const p = projectLatLon(lat, gsMap.centerLon);
        ctx.beginPath();
        ctx.moveTo(0, p.y);
        ctx.lineTo(w, p.y);
        ctx.stroke();
        const isTm2 = lat >= 21.5 && lat <= 26.5 && gsMap.centerLon >= 118.0 && gsMap.centerLon <= 122.3;
        let lbl;
        if (isTm2) {
          const lon0 = gsMap.centerLon < 119.8 ? 119.0 : 121.0;
          const tm = wgs84ToTransverseMercatorJS(lat, gsMap.centerLon, lon0, 250000.0, 0.9999, 298.257222101);
          lbl = `N:${Math.round(tm.n)}m`;
        } else {
          lbl = `${lat.toFixed(gsMap.zoom >= 13 ? 3 : 2)}°`;
        }
        ctx.fillText(lbl, 14, p.y - 4);
      }

      // Draw Scan Geofence Rings & Position Cluster Blobs (Strictly Georeferenced Sites Only)
      gsMap.groups.forEach((grp) => {
        if (!grp.hasGeoref || !Number.isFinite(grp.lat) || !Number.isFinite(grp.lon)) return;
        const pos = projectLatLon(grp.lat, grp.lon);
        const isCurrentGroup = grp.project_group === STATE.activeProjectGroup;

        // Outer radar ring
        ctx.strokeStyle = isCurrentGroup ? "rgba(2, 132, 199, 0.65)" : "rgba(56, 189, 248, 0.40)";
        ctx.lineWidth = isCurrentGroup ? 1.8 : 1.2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 58, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // Inner geofence ring
        ctx.strokeStyle = "#0284c7";
        ctx.fillStyle = isCurrentGroup ? "rgba(2, 132, 199, 0.28)" : "rgba(2, 132, 199, 0.16)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 36, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        if (grp.el) {
          grp.el.style.left = `${pos.x}px`;
          grp.el.style.top = `${pos.y}px`;
        }
      });
    };

    gsMap.drawMap = drawMap;
    gsMap.panByPixels = panByPixels;
    gsMap.zoomAroundClientPoint = zoomAroundClientPoint;

    // Map Zoom Buttons
    document.getElementById("btnMapZoomIn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      gsMap.zoom = Math.min(19.0, gsMap.zoom + 0.75);
      drawMap();
    });
    document.getElementById("btnMapZoomOut")?.addEventListener("click", (e) => {
      e.stopPropagation();
      gsMap.zoom = Math.max(2.0, gsMap.zoom - 0.75);
      drawMap();
    });
    document.getElementById("btnMapResetView")?.addEventListener("click", (e) => {
      e.stopPropagation();
      fitMapToAllGeorefGroups();
      drawMap();
    });

    // Map Layer Switcher (Hybrid vs Map)
    document.querySelectorAll("#mapLayerSwitcher .btn-seg").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#mapLayerSwitcher .btn-seg").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        STATE.mapLyrs = btn.dataset.lyrs || "y";
        drawMap();
      });
    });

    const isInteractiveMapHudControl = (target) => {
      if (!target || !target.closest) return false;
      return Boolean(target.closest(".gs-map-zoom-controls, input, select, button, a"));
    };

    // Dedicated Touch Events (passive: false) for 1-finger pan & 2-finger pinch-to-zoom on Android/iOS tablets
    container.addEventListener(
      "touchstart",
      (e) => {
        if (isInteractiveMapHudControl(e.target)) return;
        if (e.touches.length === 1) {
          const t = e.touches[0];
          gsMap.dragging = true;
          gsMap.dragMovedPx = 0;
          gsMap.lastX = t.clientX;
          gsMap.lastY = t.clientY;
          gsMap.pinchPrevDist = 0;
          gsMap.pinchPrevMid = null;
          gsMap.touchStartClusterBlob = e.target && e.target.closest ? e.target.closest(".scan-cluster-blob") : null;
          updateCursorCoordsHud(t.clientX, t.clientY);
        } else if (e.touches.length >= 2) {
          if (e.cancelable) e.preventDefault();
          const t0 = e.touches[0];
          const t1 = e.touches[1];
          gsMap.dragging = false;
          gsMap.touchStartClusterBlob = null;
          gsMap.pinchPrevDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
          gsMap.pinchPrevMid = {
            x: (t0.clientX + t1.clientX) * 0.5,
            y: (t0.clientY + t1.clientY) * 0.5,
          };
        }
      },
      { passive: false }
    );

    container.addEventListener(
      "touchmove",
      (e) => {
        if (isInteractiveMapHudControl(e.target) && !gsMap.dragging && !gsMap.pinchPrevDist) return;
        if (e.touches.length === 1) {
          if (e.cancelable) e.preventDefault();
          const t = e.touches[0];
          if (!gsMap.dragging) {
            gsMap.dragging = true;
            gsMap.lastX = t.clientX;
            gsMap.lastY = t.clientY;
            return;
          }
          const dx = t.clientX - gsMap.lastX;
          const dy = t.clientY - gsMap.lastY;
          gsMap.dragMovedPx += Math.hypot(dx, dy);
          gsMap.lastX = t.clientX;
          gsMap.lastY = t.clientY;
          panByPixels(dx, dy);
          updateCursorCoordsHud(t.clientX, t.clientY);
        } else if (e.touches.length >= 2) {
          if (e.cancelable) e.preventDefault();
          const t0 = e.touches[0];
          const t1 = e.touches[1];
          const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
          const midX = (t0.clientX + t1.clientX) * 0.5;
          const midY = (t0.clientY + t1.clientY) * 0.5;
          if (gsMap.pinchPrevMid) {
            panByPixels(midX - gsMap.pinchPrevMid.x, midY - gsMap.pinchPrevMid.y);
          }
          if (gsMap.pinchPrevDist > 12 && dist > 12) {
            const zoomDelta = Math.log2(dist / gsMap.pinchPrevDist);
            zoomAroundClientPoint(gsMap.zoom + zoomDelta, midX, midY);
          }
          gsMap.pinchPrevDist = dist;
          gsMap.pinchPrevMid = { x: midX, y: midY };
          gsMap.dragMovedPx += 10;
        }
      },
      { passive: false }
    );

    const handleTouchEndOrCancel = (e) => {
      if (!e.touches || e.touches.length === 0) {
        gsMap.dragging = false;
        gsMap.pinchPrevDist = 0;
        gsMap.pinchPrevMid = null;
        gsMap.touchStartClusterBlob = null;
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        gsMap.dragging = true;
        gsMap.lastX = t.clientX;
        gsMap.lastY = t.clientY;
        gsMap.pinchPrevDist = 0;
        gsMap.pinchPrevMid = null;
      }
    };
    container.addEventListener("touchend", handleTouchEndOrCancel, { passive: false });
    container.addEventListener("touchcancel", handleTouchEndOrCancel, { passive: false });

    // Pointer Events for Mouse & Stylus only (touch is handled exclusively by Touch Events above)
    container.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      if (isInteractiveMapHudControl(e.target)) return;
      gsMap.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!e.target.closest || !e.target.closest(".scan-cluster-blob")) {
        try {
          container.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      if (gsMap.activePointers.size === 1) {
        gsMap.dragging = true;
        gsMap.dragMovedPx = 0;
        gsMap.lastX = e.clientX;
        gsMap.lastY = e.clientY;
        canvas.style.cursor = "grabbing";
      } else if (gsMap.activePointers.size === 2) {
        const pts = Array.from(gsMap.activePointers.values());
        gsMap.dragging = false;
        gsMap.pinchPrevDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        gsMap.pinchPrevMid = { x: (pts[0].x + pts[1].x) * 0.5, y: (pts[0].y + pts[1].y) * 0.5 };
      }
    });

    const releasePointer = (e) => {
      if (e.pointerType === "touch") return;
      gsMap.activePointers.delete(e.pointerId);
      if (gsMap.activePointers.size === 0) {
        gsMap.dragging = false;
        gsMap.pinchPrevDist = 0;
        gsMap.pinchPrevMid = null;
        canvas.style.cursor = "grab";
      } else if (gsMap.activePointers.size === 1) {
        const remaining = Array.from(gsMap.activePointers.values())[0];
        gsMap.dragging = true;
        gsMap.lastX = remaining.x;
        gsMap.lastY = remaining.y;
        gsMap.pinchPrevDist = 0;
        gsMap.pinchPrevMid = null;
      }
    };
    window.addEventListener("pointerup", releasePointer);
    window.addEventListener("pointercancel", releasePointer);

    window.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      if (!gsMap || STATE.activeView !== "map") return;
      updateCursorCoordsHud(e.clientX, e.clientY);
      if (gsMap.activePointers.has(e.pointerId)) {
        gsMap.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (gsMap.activePointers.size >= 2) {
        const pts = Array.from(gsMap.activePointers.values());
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const midX = (pts[0].x + pts[1].x) * 0.5;
        const midY = (pts[0].y + pts[1].y) * 0.5;
        if (gsMap.pinchPrevMid) {
          panByPixels(midX - gsMap.pinchPrevMid.x, midY - gsMap.pinchPrevMid.y);
        }
        if (gsMap.pinchPrevDist > 12 && dist > 12) {
          zoomAroundClientPoint(gsMap.zoom + Math.log2(dist / gsMap.pinchPrevDist), midX, midY);
        }
        gsMap.pinchPrevDist = dist;
        gsMap.pinchPrevMid = { x: midX, y: midY };
        gsMap.dragMovedPx += 10;
        return;
      }
      if (gsMap.dragging) {
        const dx = e.clientX - gsMap.lastX;
        const dy = e.clientY - gsMap.lastY;
        gsMap.dragMovedPx += Math.hypot(dx, dy);
        gsMap.lastX = e.clientX;
        gsMap.lastY = e.clientY;
        panByPixels(dx, dy);
      }
    });

    container.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.35 : -0.35;
        zoomAroundClientPoint(gsMap.zoom + delta, e.clientX, e.clientY);
      },
      { passive: false }
    );
  }

  function renderMapClusters() {
    initMap();
    if (!gsMap) return;

    gsMap.markerLayer.innerHTML = "";
    const allGroups = getProjectGroupsList("");
    const visibleGroups = getProjectGroupsList(STATE.projectFilterQuery);
    gsMap.groups = visibleGroups;
    if (!gsMap._initialFitDone && allGroups.some((g) => g.hasGeoref)) {
      fitMapToAllGeorefGroups(allGroups);
      gsMap._initialFitDone = true;
    }

    const countEl = document.getElementById("lblMapClusterCount");
    if (countEl) {
      if (STATE.projectFilterQuery) {
        countEl.textContent = `${visibleGroups.length}/${allGroups.length} Sites`;
      } else {
        countEl.textContent = `${allGroups.length} Site${allGroups.length === 1 ? "" : "s"} (${STATE.scans.length} Scans)`;
      }
    }

    populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);

    visibleGroups.forEach((grp) => {
      if (!grp.hasGeoref || !Number.isFinite(grp.lat) || !Number.isFinite(grp.lon)) return;
      const count = grp.scans.length;
      const sizePx = count >= 2 ? 50 : 44;
      const blob = document.createElement("div");
      blob.className = "scan-cluster-blob" + (grp.project_group === STATE.activeProjectGroup ? " active-cluster" : "");
      blob.dataset.projectGroup = grp.project_group;
      blob.style.position = "absolute";
      blob.style.width = `${sizePx}px`;
      blob.style.height = `${sizePx}px`;
      blob.style.transform = "translate(-50%, -50%)";
      blob.style.pointerEvents = "auto";
      blob.style.touchAction = "none";
      blob.innerHTML = `
        <span>${count}</span>
        <div class="blob-label">${escapeHtml(grp.project_group)} (${count})</div>
      `;

      blob.addEventListener("click", (e) => {
        if (gsMap && gsMap.dragMovedPx > 8) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        gsMap.centerLat = grp.lat;
        gsMap.centerLon = grp.lon;
        gsMap.zoom = Math.max(gsMap.zoom || 12, 13.8);
        openClusterPopover(grp);
        gsMap.drawMap();
      });

      grp.el = blob;
      gsMap.markerLayer.appendChild(blob);
    });

    gsMap.drawMap();
    if (STATE.activeProjectGroup === "__all__") {
      document.getElementById("clusterHoverPopover")?.classList.remove("active");
      document.querySelectorAll(".scan-cluster-blob").forEach((b) => b.classList.remove("active-cluster"));
    } else if (visibleGroups.length > 0) {
      const activeGrp =
        visibleGroups.find((g) => g.project_group === STATE.activeProjectGroup) || visibleGroups[0];
      openClusterPopover(activeGrp);
    }
  }

  function formatCoveredAreaM2(scan) {
    if (!scan) return "0 m²";
    let area = Number(scan.covered_area_m2 || 0);
    if (!(area > 0)) {
      const he =
        scan.bounding_box && Array.isArray(scan.bounding_box.half_extents)
          ? scan.bounding_box.half_extents
          : [120, 120, 30];
      const hx = Math.max(Number(he[0] || 120), 10);
      const hy = Math.max(Number(he[1] || 120), 10);
      area = hx * 2 * (hy * 2) * 0.68;
    }
    return `${Math.round(area).toLocaleString("en-US")} m²`;
  }

  function formatScanPolyCount(scan, { short = false } = {}) {
    if (!scan) return "— polys";
    const polys = Number(scan._live_poly_count || scan.poly_count || 0);
    if (!(polys > 0)) return "— polys";
    if (short) {
      if (polys >= 1000000) return `${(polys / 1000000).toFixed(2)}M polys`;
      if (polys >= 1000) return `${Math.round(polys / 1000)}K polys`;
    }
    return `${Math.round(polys).toLocaleString("en-US")} polys`;
  }

  function formatScanTextureSize(scan, { short = false } = {}) {
    if (!scan) return "4096×4096 px";
    const cnt = Number(scan.texture_count || 1);
    const w = Number(scan.texture_width || scan.texture_resolution || 4096);
    const h = Number(scan.texture_height || scan.texture_resolution || w);
    if (short) {
      const kTag = w >= 8192 ? "8K" : w >= 4096 ? "4K" : w >= 2048 ? "2K" : `${w}px`;
      return cnt > 1 && cnt <= 8 ? `${kTag}×${cnt}` : kTag;
    }
    if (scan.texture_size_label) return String(scan.texture_size_label);
    return cnt > 1 && cnt <= 8 ? `${w}×${h} px (×${cnt})` : `${w}×${h} px`;
  }

  function formatScanSizeMb(scan, { includeTotal = false } = {}) {
    if (!scan) return "0.0 MB";
    const streamMb = Number(scan.scan_size_mb || scan.stream_size_mb || 0);
    const totalMb = Number(scan.size_mb || (Number(scan.size_bytes || 0) / 1048576) || 0);
    const primaryMb = streamMb > 0 ? streamMb : totalMb;
    if (includeTotal && streamMb > 0 && totalMb > streamMb + 1.0) {
      return `${primaryMb.toFixed(1)} MB (${totalMb.toFixed(1)} MB total)`;
    }
    return `${primaryMb.toFixed(1)} MB`;
  }

  function updateStudioScanMetricsReadout(scan = STATE.activeScan) {
    const metricsEl = document.getElementById("studioScanMetrics");
    if (!metricsEl || !scan) return;

    // Also inspect live loaded Three.js studio scene if available
    if (studioThree && studioThree.modelPivot && scan.scan_id === STATE.activeScanId) {
      let liveTris = 0;
      const liveTexDims = [];
      const seenTex = new Set();
      studioThree.modelPivot.traverse((node) => {
        if (node && node.isMesh && node.geometry && node.visible !== false) {
          const g = node.geometry;
          if (g.index) {
            liveTris += Math.floor(g.index.count / 3);
          } else if (g.attributes && g.attributes.position) {
            liveTris += Math.floor(g.attributes.position.count / 3);
          }
          const mats = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
          mats.forEach((m) => {
            const map = m && m.map;
            const img = map && map.image;
            if (img && img.width > 0 && img.height > 0 && !seenTex.has(map.uuid)) {
              seenTex.add(map.uuid);
              liveTexDims.push([Number(img.width), Number(img.height)]);
            }
          });
        }
      });
      if (liveTris > 0 && (!scan.poly_count || scan._has_staged_crop_preview)) {
        scan._live_poly_count = liveTris;
      } else {
        delete scan._live_poly_count;
      }
      if (!scan.texture_size_label && liveTexDims.length > 0) {
        const mw = Math.max(...liveTexDims.map((d) => d[0]));
        const mh = Math.max(...liveTexDims.map((d) => d[1]));
        scan.texture_width = mw;
        scan.texture_height = mh;
        scan.texture_count = liveTexDims.length;
        scan.texture_size_label =
          liveTexDims.length > 1 && liveTexDims.length <= 8
            ? `${mw}×${mh} px (×${liveTexDims.length})`
            : `${mw}×${mh} px`;
      }
    }

    const crsText = getScanCrsDisplayLabel(scan);
    const areaText = formatCoveredAreaM2(scan);
    const polyText = formatScanPolyCount(scan);
    const texText = formatScanTextureSize(scan);
    const sizeText = formatScanSizeMb(scan);

    metricsEl.textContent = `${crsText} · ${areaText} · ${polyText} · ${texText} · ${sizeText}`;
    const totalDiskMb = Number(scan.size_mb || (Number(scan.size_bytes || 0) / 1048576) || 0);
    const objMb = Number(scan.obj_size_mb || 0);
    metricsEl.title = [
      `CRS: ${crsText}`,
      `Covered Area: ${areaText}`,
      `Polygon Count: ${polyText}`,
      `Texture Size: ${texText}`,
      `3D Scan Size (GLB): ${sizeText}`,
      objMb > 0 ? `OBJ + Textures Export Size: ${objMb.toFixed(1)} MB` : null,
      totalDiskMb > 0 ? `Total Project Folder Size: ${totalDiskMb.toFixed(1)} MB` : null,
    ]
      .filter(Boolean)
      .join(" | ");
  }

  function closeDownloadFormatMenu() {
    const existing = document.getElementById("gsDownloadFormatPopover");
    if (existing) existing.remove();
  }

  function openDownloadFormatMenu(anchorEl, scan = STATE.activeScan) {
    if (!scan || !scan.scan_id) return;
    const existing = document.getElementById("gsDownloadFormatPopover");
    if (existing && existing.dataset.scanId === scan.scan_id && existing.dataset.anchorId === (anchorEl?.id || "")) {
      existing.remove();
      return;
    }
    closeDownloadFormatMenu();

    const sid = encodeURIComponent(scan.scan_id);
    const url3tz = appendAuthToDownloadUrl(scan.download_3tz_url || `/api/download?scan_id=${sid}&type=3tz`);
    const urlGlb = appendAuthToDownloadUrl(scan.download_glb_url || `/api/download?scan_id=${sid}&type=glb`);
    const urlObj = appendAuthToDownloadUrl(scan.download_obj_url || `/api/download?scan_id=${sid}&type=obj`);
    const urlZip = appendAuthToDownloadUrl(scan.download_zip_url || `/api/download?scan_id=${sid}&type=zip`);

    const streamMbStr = formatScanSizeMb(scan);
    const objMb = Number(scan.obj_size_mb || 0);
    const objMbStr = objMb > 0 ? `${objMb.toFixed(1)} MB` : "Georef Mesh";
    const crsLabel = getScanCrsDisplayLabel(scan);
    const safeScanName = escapeHtml(scan.name || scan.scan_id);

    const pop = document.createElement("div");
    pop.id = "gsDownloadFormatPopover";
    pop.dataset.scanId = scan.scan_id;
    pop.dataset.anchorId = anchorEl?.id || "";
    pop.style.cssText = [
      "position:fixed",
      "z-index:9999",
      "width:310px",
      "background:var(--ui-bg-window)",
      "backdrop-filter:blur(16px)",
      "border:1px solid var(--ui-border-strong)",
      "border-radius:10px",
      "box-shadow:0 14px 36px rgba(0,0,0,0.32)",
      "padding:8px",
      "color:var(--ui-text-primary)",
      "font-family:var(--sans, system-ui, sans-serif)",
    ].join(";");

    const formats = [
      {
        ext: ".3tz",
        title: "3D Tiles Package (.3tz)",
        badge: streamMbStr,
        desc: "Complete Cesium / 3D Tileset archive (tileset.json + .glb tiles + preview LOD)",
        url: url3tz,
        color: "#0284c7",
      },
      {
        ext: ".glb",
        title: "Binary glTF 2.0 Model (.glb)",
        badge: `${formatScanTextureSize(scan, { short: true })} Embedded`,
        desc: "Single self-contained 3D model with embedded JPEG textures (Blender, 3D Viewer, Three.js)",
        url: urlGlb,
        color: "#10b981",
      },
      {
        ext: ".obj",
        title: "Wavefront .OBJ Mesh (.obj)",
        badge: crsLabel,
        desc: "Georeferenced world-coordinate .obj geometry for Civil 3D, AutoCAD & CloudCompare",
        url: urlObj,
        color: "#f59e0b",
      },
      {
        ext: ".zip",
        title: "Textured .OBJ + .MTL + .JPG (.zip)",
        badge: objMbStr,
        desc: "Full Wavefront .obj + .mtl + full-res .jpg texture atlases + offset.xyz in one ZIP",
        url: urlZip,
        color: "#8b5cf6",
      },
    ];

    pop.innerHTML = `
      <div style="padding:4px 6px 7px;border-bottom:1px solid var(--ui-border);margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <div style="min-width:0;">
          <div style="font-size:11.5px;font-weight:700;color:var(--ui-text-primary);">Download 3D Scan (選擇下載格式)</div>
          <div style="font-size:10px;color:var(--ui-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${safeScanName}">${safeScanName} · ${escapeHtml(formatScanPolyCount(scan, { short: true }))}</div>
        </div>
        <button type="button" id="btnCloseDlPopover" style="background:none;border:none;color:var(--ui-text-muted);cursor:pointer;font-size:13px;padding:2px 5px;line-height:1;" title="Close">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:5px;">
        ${formats
          .map(
            (f) => `
          <a href="${escapeHtml(f.url)}" download data-dl-ext="${escapeHtml(f.ext)}" style="display:flex;align-items:flex-start;gap:9px;padding:7px 8px;border-radius:7px;border:1px solid var(--ui-border);background:var(--ui-bg-surface);text-decoration:none;color:inherit;transition:background 0.12s,border-color 0.12s;">
            <span style="flex-shrink:0;min-width:38px;text-align:center;font-family:monospace;font-size:11px;font-weight:800;padding:3px 5px;border-radius:5px;background:${f.color}20;color:${f.color};border:1px solid ${f.color}55;margin-top:1px;">${escapeHtml(f.ext)}</span>
            <span style="flex:1;min-width:0;">
              <span style="display:flex;justify-content:space-between;align-items:center;gap:4px;">
                <span style="font-size:11.5px;font-weight:700;color:var(--ui-text-primary);">${escapeHtml(f.title)}</span>
                <span style="font-size:9.5px;font-family:monospace;color:var(--ui-text-secondary);background:var(--ui-bg-subtle);padding:1px 5px;border-radius:4px;white-space:nowrap;">${escapeHtml(f.badge)}</span>
              </span>
              <span style="display:block;font-size:10px;color:var(--ui-text-secondary);line-height:1.35;margin-top:2px;">${escapeHtml(f.desc)}</span>
            </span>
          </a>
        `
          )
          .join("")}
      </div>
    `;

    document.body.appendChild(pop);

    // Position near anchorEl
    if (anchorEl && typeof anchorEl.getBoundingClientRect === "function") {
      const rect = anchorEl.getBoundingClientRect();
      const popRect = pop.getBoundingClientRect();
      let left = rect.left;
      if (left + popRect.width > window.innerWidth - 12) {
        left = Math.max(12, window.innerWidth - popRect.width - 12);
      }
      let top = rect.bottom + 6;
      if (top + popRect.height > window.innerHeight - 12) {
        top = Math.max(12, rect.top - popRect.height - 6);
      }
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(top)}px`;
    } else {
      pop.style.top = "64px";
      pop.style.right = "24px";
    }

    pop.querySelector("#btnCloseDlPopover")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeDownloadFormatMenu();
    });

    pop.querySelectorAll("a[data-dl-ext]").forEach((aEl) => {
      aEl.addEventListener("mouseenter", () => {
        aEl.style.borderColor = "var(--ui-accent)";
      });
      aEl.addEventListener("mouseleave", () => {
        aEl.style.borderColor = "var(--ui-border)";
      });
      aEl.addEventListener("click", () => {
        const ext = aEl.getAttribute("data-dl-ext") || "";
        // Refresh session_token right on click
        aEl.href = appendAuthToDownloadUrl(aEl.getAttribute("href") || "");
        SHARE_TELEMETRY.recordDownload(ext, scan);
        showToast(`Preparing ${scan.name || scan.scan_id} (${ext}) download...`);
        setTimeout(() => closeDownloadFormatMenu(), 120);
      });
    });

    setTimeout(() => {
      const onDocClick = (ev) => {
        const curPop = document.getElementById("gsDownloadFormatPopover");
        if (!curPop) {
          document.removeEventListener("mousedown", onDocClick);
          return;
        }
        if (!curPop.contains(ev.target) && (!anchorEl || !anchorEl.contains(ev.target))) {
          closeDownloadFormatMenu();
          document.removeEventListener("mousedown", onDocClick);
        }
      };
      document.addEventListener("mousedown", onDocClick);
    }, 10);
  }

  function openClusterPopover(grp) {
    const pop = document.getElementById("clusterHoverPopover");
    if (!pop || !grp) return;
    pop.classList.add("active");

    // Scope active project to the selected cluster so Studio & Compare only list this project's scans (Fix #4)
    STATE.activeProjectGroup = grp.project_group;
    document.querySelectorAll(".scan-cluster-blob").forEach((b) => {
      b.classList.toggle("active-cluster", b.dataset.projectGroup === grp.project_group);
    });
    const sortedScans = (grp.scans || [])
      .slice()
      .sort((a, b) => String(b.capture_date || "").localeCompare(String(a.capture_date || "")));

    if (sortedScans.length > 0) {
      const currInGroup = sortedScans.find((s) => s.scan_id === STATE.activeScanId);
      if (!currInGroup || (currInGroup.status !== "completed" && sortedScans.some((s) => s.status === "completed"))) {
        const bestScan = sortedScans.find((s) => s.status === "completed") || sortedScans[0];
        STATE.activeScanId = bestScan.scan_id;
        STATE.activeScan = bestScan;
      }
    }
    populateProjectScanDropdowns(grp.project_group, STATE.activeScanId);
    if (gsMap && gsMap.drawMap) gsMap.drawMap();

    document.getElementById("popoverGroupTitle").textContent = `${grp.project_group} (${grp.scans.length})`;
    document.getElementById("popoverGroupSubtitle").textContent =
      `${grp.project_name_zh || "工程掃描群組"} · TWD97 (121) + TWVD2001`;

    // Unified 3-Pane Workbench: keep Top-Right Timeline Cards + Bottom-Right 3D Preview synced when on Map view
    if (STATE.activeView === "map" || !document.getElementById("siteTimelineTilesTrack")?.children.length) {
      openSiteTimeline(
        grp.project_group,
        STATE.selectedTimelineScanId || STATE.activeScanId || (sortedScans[0] ? sortedScans[0].scan_id : null),
        false
      );
    }

    const btnOpenTimeline = document.getElementById("btnPopoverOpenTimeline");
    if (btnOpenTimeline) {
      btnOpenTimeline.onclick = () => {
        openSiteTimeline(grp.project_group, STATE.activeScanId || (sortedScans[0] ? sortedScans[0].scan_id : null), true);
      };
    }

    const btnCompare = document.getElementById("btnPopoverCompareGroup");
    if (btnCompare) {
      btnCompare.onclick = () => {
        const s1 = sortedScans[0];
        const s2 = sortedScans[1] || sortedScans[0];
        if (s1 && s2) launchMultiDateCompare(s2.scan_id, s1.scan_id);
      };
    }

    const btnShare = document.getElementById("btnPopoverShareGroup");
    if (btnShare) {
      btnShare.style.display = !STATE.shareToken && getCurrentUserRoleInfo().level >= 3 ? "inline-flex" : "none";
      btnShare.onclick = () => {
        openSharingModal("group", grp.project_group);
      };
    }

    const listEl = document.getElementById("popoverScanList");
    listEl.innerHTML = "";

    sortedScans.forEach((scan) => {
      const card = document.createElement("div");
      const isSelected = scan.scan_id === STATE.activeScanId;
      card.className = "gs-scan-item-card" + (isSelected ? " active" : "");
      card.dataset.scanId = scan.scan_id;
      card.style.cursor = "pointer";
      const isCached = STATE.cachedScanIds.has(scan.scan_id);
      const thumbSrc = scan.thumbnail_url || `/api/scans/${encodeURIComponent(scan.scan_id)}/thumbnail`;
      const texRes = Number(scan.texture_resolution || 4096);
      const texLabel = formatScanTextureSize(scan, { short: true });
      const polyShort = formatScanPolyCount(scan, { short: true });
      const sizeShort = formatScanSizeMb(scan);
      const safeId = escapeHtml(scan.scan_id);
      const safeThumbSrc = escapeHtml(thumbSrc);
      const safeName = escapeHtml(scan.name || scan.scan_id);
      const safeDate = escapeHtml(scan.capture_date || "");
      const safeUploaderName = escapeHtml(scan.uploader_name || "");
      const safeUploaderEmail = escapeHtml(scan.uploader_email || "");
      const safeDownloadObjUrl = escapeHtml(
        appendAuthToDownloadUrl(scan.download_obj_url || `/api/download?scan_id=${encodeURIComponent(scan.scan_id)}&type=obj`)
      );
      const coordReadout = escapeHtml(
        formatScanCoordReadout({ e: scan.twd97_e, n: scan.twd97_n, h: scan.twd97_h }, scan)
      );
      card.innerHTML = `
        <div class="gs-map-tile-thumb-wrap">
          <img class="gs-map-tile-thumb" data-scan-thumb="${safeId}" src="${safeThumbSrc}" alt="${safeName}" />
          <div class="gs-tile-badge-row">
            <span class="gs-tile-chip">${escapeHtml(polyShort)} · ${escapeHtml(texLabel)} · ${escapeHtml(sizeShort)}</span>
            <span class="gs-tile-chip">${escapeHtml(formatCoveredAreaM2(scan))}</span>
          </div>
        </div>
        <div class="gs-map-tile-body">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <div style="min-width:0;flex:1;">
              <div style="font-size:12.5px;font-weight:700;color:var(--ui-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${safeName}">${safeName}</div>
              <div style="font-size:11px;color:var(--ui-text-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${safeDate} · ${safeUploaderName} (<span style="color:var(--ui-accent);">${safeUploaderEmail}</span>)
              </div>
            </div>
          </div>
          <div style="font-size:10.5px;font-family:monospace;color:var(--ui-text-muted);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="Polygons: ${escapeHtml(formatScanPolyCount(scan))} | Texture: ${escapeHtml(formatScanTextureSize(scan))} | Scan Size: ${escapeHtml(formatScanSizeMb(scan, { includeTotal: true }))}">
            ${escapeHtml(formatScanPolyCount(scan))} · ${escapeHtml(formatScanTextureSize(scan))} · ${escapeHtml(sizeShort)}
          </div>
          <div style="font-size:10.5px;font-family:monospace;color:var(--ui-text-muted);margin-top:3px;">
            ${coordReadout}${isCached ? " · Cached" : ""}
          </div>
          <div class="gs-scan-item-actions">
            <button type="button" class="btn-xs primary" data-action="open3d" title="Enlarge Full-Quality 3D Scan in Studio">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 3 21 3 21 9"/>
                <polyline points="9 21 3 21 3 15"/>
                <line x1="21" y1="3" x2="14" y2="10"/>
                <line x1="3" y1="21" x2="10" y2="14"/>
              </svg>
            </button>
            <button type="button" class="btn-xs" data-action="compare" title="Compare Dates in Split Slider">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>
              </svg>
            </button>
            ${
              getCurrentUserRoleInfo().allowDownload
                ? `<button type="button" class="btn-xs" data-action="download" title="Download 3D Scan (.3tz, .glb, .obj, .zip)" style="gap:2px;">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.2" style="opacity:0.75;">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </button>`
                : ""
            }
            ${
              getCurrentUserRoleInfo().allowComments
                ? `<button type="button" class="btn-xs" data-action="comments" title="Comments (${scan.comment_count || 0})">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                  </button>`
                : ""
            }
            ${
              !STATE.shareToken && getCurrentUserRoleInfo().level >= 3
                ? `<button type="button" class="btn-xs" data-action="share" title="Create Scoped Share Link">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                      <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                    </svg>
                  </button>`
                : ""
            }
            ${
              !STATE.shareToken && getCurrentUserRoleInfo().canEditNames
                ? `<button type="button" class="btn-xs" data-action="rename" title="Edit Scan Name">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                    </svg>
                  </button>
                  <button type="button" class="btn-xs" data-action="delete" title="Delete Scan (刪除掃描)" style="color:#ef4444;">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                  </button>`
                : ""
            }
          </div>
        </div>
      `;

      card.addEventListener("click", (ev) => {
        if (ev.target.closest("button") || ev.target.closest("a")) return;
        STATE.activeProjectGroup = scan.project_group;
        STATE.activeScanId = scan.scan_id;
        STATE.activeScan = scan;
        STATE.selectedTimelineScanId = scan.scan_id;
        document.querySelectorAll("#popoverScanList .gs-scan-item-card").forEach((c) => {
          c.classList.toggle("active", c.dataset.scanId === scan.scan_id);
        });
        openSiteTimeline(scan.project_group, scan.scan_id);
      });

      card.querySelector('[data-action="open3d"]')?.addEventListener("click", () => {
        STATE.activeProjectGroup = scan.project_group;
        populateProjectScanDropdowns(scan.project_group, scan.scan_id);
        switchView("studio", scan.scan_id);
      });
      card.querySelector('[data-action="compare"]')?.addEventListener("click", () => {
        STATE.activeProjectGroup = scan.project_group;
        const other = grp.scans.find((s) => s.scan_id !== scan.scan_id) || scan;
        launchMultiDateCompare(other.scan_id, scan.scan_id);
      });
      const dlCardBtn = card.querySelector('[data-action="download"]');
      if (dlCardBtn) {
        dlCardBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openDownloadFormatMenu(dlCardBtn, scan);
        });
      }
      card.querySelector('[data-action="comments"]')?.addEventListener("click", () => {
        STATE.activeProjectGroup = scan.project_group;
        populateProjectScanDropdowns(scan.project_group, scan.scan_id);
        switchView("studio", scan.scan_id);
        setTimeout(() => openCommentsInspector(), 250);
      });
      const shareBtn = card.querySelector('[data-action="share"]');
      if (shareBtn) {
        shareBtn.addEventListener("click", () => openSharingModal("scan", scan.scan_id));
      }
      const renameBtn = card.querySelector('[data-action="rename"]');
      if (renameBtn) {
        renameBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openRenameScanModal(scan.scan_id);
        });
      }
      const deleteBtn = card.querySelector('[data-action="delete"]');
      if (deleteBtn) {
        deleteBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openDeleteScanModal(scan.scan_id);
        });
      }

      listEl.appendChild(card);
    });
  }

  // ============================================================================
  // 1B. SITE TIMELINE (TOP) + INTERACTIVE 3D PREVIEW (BOTTOM) + ENLARGE
  // ============================================================================
  let previewThree = null;

  function getActivePreviewContainer() {
    return document.getElementById("sitePreviewCanvasContainer");
  }

  function syncPreviewRendererContainer() {
    if (!previewThree) return;
    const targetContainer = getActivePreviewContainer();
    if (!targetContainer) return;
    if (previewThree.renderer.domElement.parentElement !== targetContainer) {
      targetContainer.appendChild(previewThree.renderer.domElement);
      previewThree.container = targetContainer;
    }
    const w = Math.max(1, targetContainer.clientWidth);
    const h = Math.max(1, targetContainer.clientHeight);
    previewThree.camera.aspect = w / h;
    previewThree.camera.updateProjectionMatrix();
    previewThree.renderer.setSize(w, h);
    if (previewThree.tilesRenderer) {
      previewThree.tilesRenderer.setResolutionFromRenderer(previewThree.camera, previewThree.renderer);
    }
  }

  function initPreview3D() {
    if (previewThree) {
      syncPreviewRendererContainer();
      return previewThree;
    }
    const container = getActivePreviewContainer();
    if (!container) return null;

    const isDark = STATE.resolvedTheme === "dark";
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(isDark ? 0x0b1120 : 0xe2e8f0);

    const camera = new THREE.PerspectiveCamera(
      50,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.1,
      10000
    );
    camera.position.set(42, 34, 48);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
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
    controls.addEventListener("end", () => {
      SHARE_TELEMETRY.recordCameraInteraction("preview");
    });
    renderer.domElement.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    renderer.domElement.addEventListener("auxclick", (e) => {
      if (e.button === 1) e.preventDefault();
    });

    scene.add(new THREE.AmbientLight(0xffffff, 0.92));
    scene.add(new THREE.HemisphereLight(0xffffff, 0x475569, 0.45));
    const dir = new THREE.DirectionalLight(0xffffff, 0.65);
    dir.position.set(110, 200, 110);
    scene.add(dir);

    const grid = new THREE.GridHelper(220, 22, isDark ? 0x334155 : 0x94a3b8, isDark ? 0x1e293b : 0xcbd5e1);
    grid.position.y = -0.2;
    scene.add(grid);

    const modelPivot = new THREE.Group();
    scene.add(modelPivot);

    const fallbackGroup = new THREE.Group();
    scene.add(fallbackGroup);

    previewThree = {
      container,
      scene,
      camera,
      renderer,
      controls,
      grid,
      modelPivot,
      fallbackGroup,
      tilesRenderer: null,
      boundingSphere: null,
    };

    buildReferenceTerrainMesh(previewThree);

    const animatePreview = () => {
      requestAnimationFrame(animatePreview);
      if (STATE.activeView !== "map") return;
      controls.update();
      if (previewThree.tilesRenderer) {
        camera.updateMatrixWorld();
        previewThree.tilesRenderer.update();
        syncTilesLoaderProgress(previewThree, "preview");
        previewThree.tilesRenderer.group.traverse((child) => {
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
      renderer.render(scene, camera);
    };
    requestAnimationFrame(animatePreview);

    return previewThree;
  }

  // Circular 3D Scan Loading Indicator (Fill/Void Ring + Centered Percentage)
  const LOADER_RING_CIRCUMFERENCE = 238.761; // 2 * Math.PI * 38

  function updateScanLoader(prefix, visible, pct, labelText) {
    const overlayEl = document.getElementById(`${prefix}ScanLoader`);
    if (!overlayEl) return;
    const arcEl = document.getElementById(`${prefix}ScanLoaderArc`);
    const pctEl = document.getElementById(`${prefix}ScanLoaderPct`);
    const lblEl = document.getElementById(`${prefix}ScanLoaderLabel`);

    const clamped = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    if (arcEl) {
      const offset = LOADER_RING_CIRCUMFERENCE * (1 - clamped / 100);
      arcEl.style.strokeDashoffset = offset.toFixed(2);
    }
    if (pctEl) {
      pctEl.textContent = `${clamped}%`;
    }
    if (lblEl && typeof labelText === "string" && labelText) {
      lblEl.textContent = labelText;
    }
    overlayEl.classList.toggle("active", Boolean(visible));
    if (visible) {
      SHARE_TELEMETRY.recordLoadProgress(clamped, false);
    }
  }

  function startScanLoader(ctx, prefix, scanName, scanId = null) {
    if (ctx) {
      if (ctx._loaderHideTimer) {
        clearTimeout(ctx._loaderHideTimer);
        ctx._loaderHideTimer = null;
      }
      ctx._loadingDone = false;
      ctx._tilesetReady = false;
      ctx._tilesetReadyMs = 0;
      ctx._loadingStartMs = performance.now();
      ctx._maxPct = 6;
      if (scanId) ctx._loadingScanId = scanId;
    }
    updateScanLoader(prefix, true, 6, `Loading ${scanName || "3D Scan"}...`);
  }

  function finishScanLoader(ctx, prefix, labelText = "Scan Ready") {
    const loadElapsedMs = ctx && ctx._loadingStartMs ? performance.now() - ctx._loadingStartMs : 0;
    SHARE_TELEMETRY.recordLoadProgress(100, true, loadElapsedMs);
    if (ctx) {
      ctx._loadingDone = true;
      ctx._maxPct = 100;
      if (ctx._loaderHideTimer) clearTimeout(ctx._loaderHideTimer);
      updateScanLoader(prefix, true, 100, labelText);
      ctx._loaderHideTimer = setTimeout(() => {
        updateScanLoader(prefix, false, 100, labelText);
        if (prefix === "preview") {
          autoCaptureSiteTimelineScreenshots();
        } else if (prefix === "studio") {
          updateStudioScanMetricsReadout(STATE.activeScan);
        }
      }, 320);
    } else {
      updateScanLoader(prefix, false, 100, labelText);
    }
  }

  function syncTilesLoaderProgress(ctx, prefix) {
    if (!ctx || !ctx.tilesRenderer || ctx._loadingDone) return;
    const stats = ctx.tilesRenderer.stats || {};
    const loaded = Number(stats.loaded || 0);
    const downloading = Number(stats.downloading || 0);
    const parsing = Number(stats.parsing || 0);
    const queued = Number(stats.queued || 0);
    const failed = Number(stats.failed || 0);
    const activeWork = downloading + parsing;
    const pending = activeWork + queued;
    const now = performance.now();
    const elapsed = now - (ctx._loadingStartMs || 0);
    const sinceTileset = ctx._tilesetReadyMs ? now - ctx._tilesetReadyMs : 0;

    // Complete as soon as primary 3D tiles are rendered or all active downloads/parses finish
    const total = Math.max(1, loaded + pending);
    const enoughTilesReady =
      loaded > 0 &&
      (pending === 0 ||
        (activeWork === 0 && sinceTileset > 900) ||
        loaded >= Math.max(4, Math.ceil(total * 0.75)));
    if (enoughTilesReady && elapsed > 220) {
      finishScanLoader(ctx, prefix, `100% · ${loaded} 3D tiles ready`);
      return;
    }

    // If a transient tunnel/network hiccup caused initial tiles to fail with 0 loaded, auto-retry once
    if (loaded === 0 && activeWork === 0 && failed > 0 && sinceTileset > 1200) {
      if (!ctx._retriedOnce && ctx._loadingScanId && prefix === "preview") {
        ctx._retriedOnce = true;
        loadScanIntoPreview(ctx._loadingScanId, true);
        return;
      }
      if (sinceTileset > 8000) {
        finishScanLoader(ctx, prefix, "Scan Ready");
        return;
      }
    }

    if (loaded > 0 || activeWork > 0 || queued > 0) {
      const timeBoost = activeWork > 0 ? Math.min(26, Math.floor(elapsed / 220)) : 0;
      const rawPct = Math.round(20 + (loaded / total) * 76) + timeBoost;
      ctx._maxPct = Math.min(96, Math.max(ctx._maxPct || 22, rawPct));
      updateScanLoader(prefix, true, ctx._maxPct, `Streaming 3D Scan · ${loaded} / ${total} tiles`);
      return;
    }

    if (!ctx._tilesetReady) {
      const waitPct = Math.min(20, 6 + Math.floor(elapsed / 120));
      ctx._maxPct = Math.max(ctx._maxPct || 6, waitPct);
      updateScanLoader(prefix, true, ctx._maxPct, "Fetching 3D tileset...");
    } else if (sinceTileset < 2500) {
      // Tileset just arrived; waiting for first frame traversal to schedule .glb downloads
      ctx._maxPct = Math.max(ctx._maxPct || 22, 22);
      updateScanLoader(prefix, true, ctx._maxPct, "Streaming 3D tiles...");
    } else if (sinceTileset > 12000) {
      finishScanLoader(ctx, prefix, "Scan Ready");
    }
  }

  function framePreviewCamera() {
    if (!previewThree) return;
    const rawR = Number(previewThree.boundingSphere?.radius) || 55;
    const r = Math.max(22, Math.min(240, rawR));
    previewThree.controls.target.set(0, 0, 0);
    previewThree.camera.position.set(r * 0.68, r * 0.54, r * 0.78);
    previewThree.camera.lookAt(0, 0, 0);
    previewThree.controls.update();
  }

  // Manually capture WebGL 3D scan screenshot and persist to tile & server when requested by user
  async function captureAndPersistScanScreenshot(scanId, ctxThree, showManualToast = false) {
    const targetCtx = ctxThree || previewThree || studioThree;
    if (!targetCtx || !targetCtx.renderer || !scanId) return;
    const loadedTiles = Number(targetCtx.tilesRenderer?.stats?.loaded || 0);
    if (targetCtx.tilesRenderer && loadedTiles === 0) return;
    try {
      targetCtx.renderer.render(targetCtx.scene, targetCtx.camera);
      const dataUrl = targetCtx.renderer.domElement.toDataURL("image/png");
      if (!dataUrl || dataUrl.length < 1024) return;

      const imgEls = document.querySelectorAll(`img[data-scan-thumb="${scanId}"]`);
      imgEls.forEach((img) => {
        img.src = dataUrl;
      });
      if (showManualToast) {
        STATE.capturedThumbs.add(scanId);
        await apiPost(`/api/scans/${encodeURIComponent(scanId)}/thumbnail`, {
          data_url: dataUrl,
        }).catch(() => {});
        showToast("Captured live 3D scan screenshot to timeline tile");
      }
    } catch (e) {
      console.warn("[GatheringScans] Screenshot capture note:", e);
    }
  }

  async function autoCaptureSiteTimelineScreenshots() {
    // Full-quality zoomed-to-extents screenshots are automatically generated on the server
    // from the high-resolution 3D tileset whenever a scan is uploaded or discovered.
    return;
  }

  function computeTilesetContentSphere(tr, outSphere) {
    if (!tr || !tr.root) return false;
    if (typeof tr.getBoundingSphere === "function") {
      tr.getBoundingSphere(outSphere);
    }
    const rootGe = Number(tr.root.geometricError || 0);
    if (rootGe > 1000) {
      tr.errorTarget = 16.0;
    } else if (tr.root.content && tr.root.content.uri) {
      tr.errorTarget = 380.0;
    }
    // If root has no direct content URI (e.g. PIX4Dmatic cubic octree where root box is in the sky),
    // check first if root.boundingVolume.box is already tightened (hx != hz). Otherwise walk content nodes up to depth 6.
    const rootBox = tr.root.boundingVolume && Array.isArray(tr.root.boundingVolume.box) ? tr.root.boundingVolume.box : null;
    const isTightRootBox = rootBox && rootBox.length >= 12 && Math.abs(Math.abs(Number(rootBox[3])) - Math.abs(Number(rootBox[11]))) > 0.5;
    if ((!tr.root.content || !tr.root.content.uri) && !isTightRootBox) {
      const rootMat = (tr.root.engineData && tr.root.engineData.transform) || new THREE.Matrix4();
      const byDepth = new Map();
      const tmpVec = new THREE.Vector3();
      const walk = (node, depth) => {
        if (!node || depth > 6) return;
        if (node.content && node.content.uri && node.boundingVolume && Array.isArray(node.boundingVolume.box)) {
          const b = node.boundingVolume.box;
          const cx = Number(b[0]) || 0;
          const cy = Number(b[1]) || 0;
          const cz = Number(b[2]) || 0;
          const hx = Math.abs(Number(b[3]) || 0) + Math.abs(Number(b[6]) || 0) + Math.abs(Number(b[9]) || 0);
          const hy = Math.abs(Number(b[4]) || 0) + Math.abs(Number(b[7]) || 0) + Math.abs(Number(b[10]) || 0);
          const hz = Math.abs(Number(b[5]) || 0) + Math.abs(Number(b[8]) || 0) + Math.abs(Number(b[11]) || 0);
          tmpVec.set(cx, cy, cz).applyMatrix4(rootMat);
          if (isFinite(tmpVec.x) && isFinite(tmpVec.y) && isFinite(tmpVec.z)) {
            if (!byDepth.has(depth)) byDepth.set(depth, []);
            byDepth.get(depth).push({
              x: tmpVec.x,
              y: tmpVec.y,
              z: tmpVec.z,
              hx,
              hy,
              hz,
            });
          }
        }
        if (Array.isArray(node.children)) {
          node.children.forEach((c) => walk(c, depth + 1));
        }
      };
      walk(tr.root, 0);
      if (byDepth.size > 0) {
        const maxDepth = Math.max(...byDepth.keys());
        const pts = byDepth.get(maxDepth) || [];
        let minX = Infinity,
          minY = Infinity,
          minZ = Infinity,
          maxX = -Infinity,
          maxY = -Infinity,
          maxZ = -Infinity;
        const zVals = [];
        for (const p of pts) {
          minX = Math.min(minX, p.x - p.hx * 0.6);
          maxX = Math.max(maxX, p.x + p.hx * 0.6);
          minY = Math.min(minY, p.y - p.hy * 0.6);
          maxY = Math.max(maxY, p.y + p.hy * 0.6);
          minZ = Math.min(minZ, p.z - p.hz * 0.6);
          maxZ = Math.max(maxZ, p.z + p.hz * 0.6);
          zVals.push(p.z);
        }
        zVals.sort((a, b) => a - b);
        const medZ = zVals.length > 0 ? zVals[Math.floor(zVals.length / 2)] : (minZ + maxZ) * 0.5;
        outSphere.center.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, medZ);
        const dx = maxX - minX;
        const dy = maxY - minY;
        const dz = maxZ - minZ;
        outSphere.radius = Math.max(18, Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.42);
        outSphere._groundOffsetY = Math.min(-1.5, minZ - medZ - 0.3);
      }
    } else if (outSphere.radius > 0) {
      outSphere.radius = Math.max(18, outSphere.radius * 0.72);
      if (rootBox && rootBox.length >= 12) {
        const hz =
          Math.abs(Number(rootBox[5]) || 0) +
          Math.abs(Number(rootBox[8]) || 0) +
          Math.abs(Number(rootBox[11]) || 0);
        outSphere._groundOffsetY = hz > 0 ? -(hz + 0.3) : -Math.max(4.0, outSphere.radius * 0.25);
      } else {
        outSphere._groundOffsetY = -Math.max(4.0, outSphere.radius * 0.25);
      }
    }
    return outSphere.radius > 0;
  }

  function loadScanIntoPreview(scanId, forceReload = false) {
    initPreview3D();
    syncPreviewRendererContainer();
    const scan = STATE.scans.find((s) => s.scan_id === scanId) || STATE.scans[0];
    if (!scan || !previewThree) return;

    const titleEl = document.getElementById("previewScanTitle");
    if (titleEl) titleEl.textContent = scan.name;
    const metaEl = document.getElementById("previewScanMeta");
    if (metaEl) {
      metaEl.textContent = `${scan.capture_date} · ${scan.uploader_name} · ${formatCoveredAreaM2(scan)} · E ${Number(scan.twd97_e).toFixed(1)} N ${Number(scan.twd97_n).toFixed(1)} H +${Number(scan.twd97_h).toFixed(2)}m`;
    }

    if (
      !forceReload &&
      previewThree._loadingScanId === scan.scan_id &&
      previewThree.tilesRenderer &&
      Number(previewThree.tilesRenderer.stats?.failed || 0) === 0
    ) {
      STATE.selectedTimelineScanId = scan.scan_id;
      STATE.activeScanId = scan.scan_id;
      STATE.activeScan = scan;
      return;
    }

    STATE.selectedTimelineScanId = scan.scan_id;
    STATE.activeScanId = scan.scan_id;
    STATE.activeScan = scan;
    SHARE_TELEMETRY.recordScanViewed(scan, "preview");

    if (previewThree.tilesRenderer) {
      previewThree.modelPivot.remove(previewThree.tilesRenderer.group);
      previewThree.tilesRenderer.dispose();
      previewThree.tilesRenderer = null;
    }
    while (previewThree.modelPivot.children.length > 0) {
      previewThree.modelPivot.remove(previewThree.modelPivot.children[0]);
    }
    previewThree.modelPivot.rotation.set(0, 0, 0);
    if (previewThree.fallbackGroup) previewThree.fallbackGroup.visible = false;

    previewThree._retriedOnce = false;
    if (scan.status && scan.status !== "completed") {
      if (previewThree.fallbackGroup) previewThree.fallbackGroup.visible = true;
      framePreviewCamera();
      finishScanLoader(
        previewThree,
        "preview",
        `Processing in PIX4Dmatic (${Math.round(Number(scan.progress_pct) || 0)}%)`
      );
      return;
    }
    startScanLoader(previewThree, "preview", `${scan.name} (Interactive Preview)`, scan.scan_id);

    const streamUrl =
      scan.preview_stream_url ||
      (scan.stream_url
        ? scan.stream_url.replace("/tileset.json", "/preview_tileset.json")
        : `/stream/${scan.scan_id}/preview_tileset.json`);
    const streamType = scan.preview_stream_type || scan.stream_type;

    if (streamType === "glb" || streamUrl.toLowerCase().endsWith(".glb")) {
      const loader = new THREE.GLTFLoader();
      if (window.MeshoptDecoder) loader.setMeshoptDecoder(window.MeshoptDecoder);
      const ktx2 = getKTX2Loader(previewThree.renderer);
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
          }
          if (previewThree.grid) {
            previewThree.grid.position.y = Number.isFinite(box.min.y)
              ? box.min.y - sphere.center.y - 0.3
              : -0.2;
          }
          model.traverse((c) => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => applyBrightnessToMaterial(m, STATE.scanBrightness));
            }
          });
          previewThree.modelPivot.add(model);
          previewThree.boundingSphere = sphere;
          framePreviewCamera();
          finishScanLoader(previewThree, "preview", "100% · Interactive Preview Ready");
        },
        (xhr) => {
          const pct =
            xhr && xhr.total > 0
              ? Math.min(95, Math.max(12, Math.round((xhr.loaded / xhr.total) * 100)))
              : Math.min(88, (previewThree._maxPct || 12) + 8);
          previewThree._maxPct = pct;
          updateScanLoader("preview", true, pct, `Loading Interactive Preview (${pct}%)...`);
        },
        () => {
          if (previewThree.fallbackGroup) previewThree.fallbackGroup.visible = true;
          finishScanLoader(previewThree, "preview", "Ready");
        }
      );
    } else if (window.TilesRenderer) {
      const tr = new window.TilesRenderer(streamUrl);
      tr.fetchOptions = { mode: "cors" };
      tr.preprocessURL = (uri) => preprocessTileStreamUrl(uri, streamUrl);
      tr.setCamera(previewThree.camera);
      tr.setResolutionFromRenderer(previewThree.camera, previewThree.renderer);

      const gltfLoader = new THREE.GLTFLoader(tr.manager);
      if (window.MeshoptDecoder) gltfLoader.setMeshoptDecoder(window.MeshoptDecoder);
      const ktx2 = getKTX2Loader(previewThree.renderer);
      if (ktx2) gltfLoader.setKTX2Loader(ktx2);
      tr.manager.addHandler(/\.(gltf|glb)(\?.*)?$/i, gltfLoader);

      tr.addEventListener("load-tileset", () => {
        previewThree._tilesetReady = true;
        previewThree._tilesetReadyMs = performance.now();
        previewThree._maxPct = Math.max(previewThree._maxPct || 0, 22);
        updateScanLoader("preview", true, previewThree._maxPct, "Streaming interactive preview...");
        const sphere = new THREE.Sphere();
        if (computeTilesetContentSphere(tr, sphere)) {
          tr.group.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
          previewThree.modelPivot.rotation.set(THREE.MathUtils.degToRad(270), 0, 0);
          previewThree.modelPivot.updateMatrixWorld(true);
          previewThree.boundingSphere = sphere;
          if (previewThree.grid) {
            previewThree.grid.position.y = Number.isFinite(sphere._groundOffsetY)
              ? sphere._groundOffsetY
              : -8.0;
          }
          framePreviewCamera();
        }
        previewThree.camera.updateMatrixWorld();
        tr.update();
      });

      tr.addEventListener("load-model", (ev) => {
        if (ev && ev.scene) {
          if (previewThree.fallbackGroup) previewThree.fallbackGroup.visible = false;
          ev.scene.traverse((c) => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => applyBrightnessToMaterial(m, STATE.scanBrightness));
            }
          });
          previewThree.camera.updateMatrixWorld();
          tr.update();
          previewThree.renderer.render(previewThree.scene, previewThree.camera);
          syncTilesLoaderProgress(previewThree, "preview");
        }
      });

      tr.errorTarget = 16.0;
      if (tr.downloadQueue) tr.downloadQueue.maxJobs = 12;
      if (tr.parseQueue) tr.parseQueue.maxJobs = 6;
      previewThree.modelPivot.add(tr.group);
      previewThree.tilesRenderer = tr;
      framePreviewCamera();
      previewThree.camera.updateMatrixWorld();
      tr.update();
      return;
    }

    framePreviewCamera();
  }

  function selectTimelineTile(scanId) {
    if (STATE._timelineInitTimer) {
      clearTimeout(STATE._timelineInitTimer);
      STATE._timelineInitTimer = null;
    }
    STATE.selectedTimelineScanId = scanId;
    const selScan = STATE.scans.find((s) => s.scan_id === scanId);
    const crsPill = document.getElementById("timelineCrsExtraPill");
    if (crsPill && selScan) {
      crsPill.textContent = getScanCrsDisplayLabel(selScan);
    }
    document.querySelectorAll("#siteTimelineTilesTrack .gs-timeline-tile").forEach((tile) => {
      const isAct = tile.dataset.scanId === scanId;
      tile.classList.toggle("active", isAct);
      const rtkChip = tile.querySelector("[data-rtk-chip]");
      if (rtkChip) rtkChip.classList.toggle("active-indicator", isAct);
    });
    document.querySelectorAll("#popoverScanList .gs-scan-item-card").forEach((c) => {
      c.classList.toggle("active", c.dataset.scanId === scanId);
    });
    loadScanIntoPreview(scanId);
  }

  function openSiteTimeline(projectGroup, preferredScanId = null, forceSwitchToMap = false) {
    const splitEl = document.getElementById("siteTimelineSplitView");
    if (!splitEl) return;

    if (STATE._timelineInitTimer) {
      clearTimeout(STATE._timelineInitTimer);
      STATE._timelineInitTimer = null;
    }

    const allGroups = getProjectGroupsList("");
    const grpName =
      projectGroup ||
      STATE.activeProjectGroup ||
      (allGroups[0] ? allGroups[0].project_group : "__all__");
    const isAllProjects = grpName === "__all__";
    STATE.activeProjectGroup = grpName;
    STATE.siteTimelineOpen = true;

    // Only switch back to Map view if explicitly requested by user navigation
    if (forceSwitchToMap && STATE.activeView !== "map") {
      switchView("map");
    }
    splitEl.classList.add("active");
    document.querySelectorAll(".scan-cluster-blob").forEach((b) => {
      b.classList.toggle("active-cluster", !isAllProjects && b.dataset.projectGroup === grpName);
    });
    if (STATE.activeView === "map") {
      syncPreviewRendererContainer();
      if (gsMap && gsMap.drawMap) gsMap.drawMap();
    }

    let siteScans = (isAllProjects ? STATE.scans : STATE.scans.filter((s) => s.project_group === grpName))
      .slice()
      .sort((a, b) => String(b.capture_date || "").localeCompare(String(a.capture_date || "")));
    if (!siteScans.length) {
      siteScans = STATE.scans
        .slice()
        .sort((a, b) => String(b.capture_date || "").localeCompare(String(a.capture_date || "")));
    }

    const chosenScan =
      (preferredScanId && siteScans.find((s) => s.scan_id === preferredScanId)) ||
      siteScans.find((s) => s.scan_id === STATE.activeScanId) ||
      siteScans[0];

    populateProjectScanDropdowns(grpName, chosenScan ? chosenScan.scan_id : null);

    const roleInfo = getCurrentUserRoleInfo();
    const btnRenSite = document.getElementById("btnRenameTimelineSite");
    if (btnRenSite) {
      btnRenSite.style.display = roleInfo.canEditNames && !isAllProjects ? "inline-flex" : "none";
    }

    // Populate Header
    const titleEl = document.getElementById("timelineSiteTitle");
    if (titleEl) {
      titleEl.textContent = isAllProjects ? "All Project Sites (全部工區)" : grpName;
    }
    const countEl = document.getElementById("timelineSiteCountPill");
    if (countEl) {
      countEl.textContent = isAllProjects
        ? `${allGroups.length} Site${allGroups.length === 1 ? "" : "s"} · ${siteScans.length} Scan${siteScans.length === 1 ? "" : "s"}`
        : `${siteScans.length} Scan${siteScans.length === 1 ? "" : "s"}`;
    }
    const crsExtraPill = document.getElementById("timelineCrsExtraPill");
    if (crsExtraPill) {
      const uniqueCrs = new Set(siteScans.map((s) => inferActiveScanCrsCode(s)));
      crsExtraPill.textContent =
        uniqueCrs.size > 1
          ? `Multi-CRS (${uniqueCrs.size}) · Auto-Aligned`
          : getScanCrsDisplayLabel(chosenScan || siteScans[0]);
    }
    const subEl = document.getElementById("timelineSiteSubtitle");
    if (subEl && siteScans[0]) {
      subEl.textContent = isAllProjects
        ? "All project sites sorted newest-first · Select any scan tile to preview below"
        : `${siteScans[0].project_name_zh || "工程掃描群組"} · Select a scan tile on the timeline to preview below`;
    }
    const timelineProjSel = document.getElementById("timelineProjectSelect");
    if (timelineProjSel && Array.from(timelineProjSel.options).some((o) => o.value === grpName)) {
      timelineProjSel.value = grpName;
    }
    const mapProjSel = document.getElementById("mapProjectSelect");
    if (mapProjSel && Array.from(mapProjSel.options).some((o) => o.value === grpName)) {
      mapProjSel.value = grpName;
    }

    // Populate Horizontal Timeline Tiles Track
    const trackEl = document.getElementById("siteTimelineTilesTrack");
    if (trackEl) {
      trackEl.innerHTML = "";
      siteScans.forEach((s) => {
        const isSelected = chosenScan && s.scan_id === chosenScan.scan_id;
        const tile = document.createElement("div");
        tile.className = "gs-timeline-tile" + (isSelected ? " active" : "");
        tile.dataset.scanId = s.scan_id;
        const thumbSrc = s.thumbnail_url || `/api/scans/${encodeURIComponent(s.scan_id)}/thumbnail`;
        const texRes = Number(s.texture_resolution || 4096);
        const texLabel = formatScanTextureSize(s, { short: true });
        const polyShort = formatScanPolyCount(s, { short: true });
        const sizeShort = formatScanSizeMb(s);
        const safeName = escapeHtml(s.name || s.scan_id);
        const safeUploader = escapeHtml(s.uploader_name || "Engineer");
        const safeEmail = escapeHtml(s.uploader_email || "");
        const safeGroup = escapeHtml(s.project_group || "");

        tile.innerHTML = `
          <div class="gs-tile-thumb-wrap">
            <img class="gs-tile-thumb" data-scan-thumb="${escapeHtml(s.scan_id)}" src="${thumbSrc}" alt="${safeName}" />
            <div class="gs-tile-badge-row">
              <span class="gs-tile-chip" title="Polygons: ${escapeHtml(formatScanPolyCount(s))} · Texture: ${escapeHtml(formatScanTextureSize(s))} · Scan Size: ${escapeHtml(sizeShort)}">${escapeHtml(polyShort)} · ${escapeHtml(texLabel)} · ${escapeHtml(sizeShort)}</span>
              <span class="gs-tile-chip ${isSelected ? "active-indicator" : ""}" data-rtk-chip="1">${formatCoveredAreaM2(s)}</span>
            </div>
          </div>
          <div class="gs-tile-meta">
            <div class="gs-tile-date-row" style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
              <span class="gs-tile-date">${escapeHtml(s.capture_date || "")}</span>
              ${
                isAllProjects && safeGroup
                  ? `<span style="font-size:9.5px;font-weight:700;padding:1px 5px;border-radius:4px;background:var(--ui-accent-soft);color:var(--ui-accent);max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${safeGroup}">${safeGroup}</span>`
                  : ""
              }
            </div>
            <div class="gs-tile-uploader" title="${safeUploader} (${safeEmail})">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
              </svg>
              <span>${safeUploader}</span>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;min-width:0;">
              <div class="gs-tile-name" title="${safeName}" style="flex:1;min-width:0;">${safeName}</div>
              <div class="gs-tile-edit-actions" style="display:${roleInfo.canEditNames ? "flex" : "none"};align-items:center;gap:2px;flex-shrink:0;">
                <button type="button" class="btn-xs" data-rename-tile="${escapeHtml(s.scan_id)}" title="Edit Scan Name" style="height:18px;padding:0 4px;">
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                  </svg>
                </button>
                <button type="button" class="btn-xs" data-delete-tile="${escapeHtml(s.scan_id)}" title="Delete Scan (刪除掃描)" style="height:18px;padding:0 4px;color:#ef4444;">
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        `;

        tile.addEventListener("click", (ev) => {
          if (ev.target.closest("[data-rename-tile]") || ev.target.closest("[data-delete-tile]")) return;
          selectTimelineTile(s.scan_id);
        });
        const renTileBtn = tile.querySelector("[data-rename-tile]");
        if (renTileBtn) {
          renTileBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            openRenameScanModal(s.scan_id);
          });
        }
        const delTileBtn = tile.querySelector("[data-delete-tile]");
        if (delTileBtn) {
          delTileBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            openDeleteScanModal(s.scan_id);
          });
        }
        trackEl.appendChild(tile);
      });
    }

    // Render 3D Scan Preview in Bottom 2/3 when on Map view
    if (chosenScan && STATE.activeView === "map") {
      STATE._timelineInitTimer = setTimeout(() => {
        STATE._timelineInitTimer = null;
        if (STATE.activeView === "map") {
          selectTimelineTile(chosenScan.scan_id);
        }
      }, 30);
    }
  }

  let _renamingScanId = "";

  function getScanDefaultFileName(scan) {
    if (!scan) return "";
    const p = String(scan.project_dir || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (p) {
      const base = p.split("/").pop();
      if (base) return base;
    }
    return scan.scan_id || "";
  }

  function openRenameScanModal(scanId) {
    const targetId = scanId || STATE.selectedTimelineScanId || STATE.activeScanId;
    const scan = STATE.scans.find((s) => s.scan_id === targetId) || STATE.activeScan;
    if (!scan) return;
    _renamingScanId = scan.scan_id;
    const fileBase = getScanDefaultFileName(scan);
    const folderInfo = document.getElementById("renameScanModalFolderInfo");
    if (folderInfo) {
      folderInfo.textContent = `File / Folder: ${fileBase} (${scan.project_group || "Site"})`;
    }
    const inp = document.getElementById("renameScanInput");
    if (inp) {
      inp.value = scan.name || fileBase;
    }
    openModal("renameScanModal");
    setTimeout(() => {
      if (inp) {
        inp.focus();
        inp.select();
      }
    }, 40);
  }

  async function saveRenamedScan() {
    const scan = STATE.scans.find((s) => s.scan_id === _renamingScanId);
    if (!scan) return;
    const inp = document.getElementById("renameScanInput");
    const newName = String(inp ? inp.value : "").trim();
    if (!newName) {
      showToast("Scan name cannot be empty");
      return;
    }
    try {
      const res = await apiPost("/api/scans/rename", {
        scan_id: scan.scan_id,
        name: newName,
      });
      const savedName = (res.scan && res.scan.name) || newName;
      scan.name = savedName;
      scan.user_edited_name = true;
      try {
        localStorage.setItem(
          "gs_last_catalog_v1",
          JSON.stringify({ scans: STATE.scans, projects: STATE.projects })
        );
      } catch (_) {}

      const prevTitle = document.getElementById("previewScanTitle");
      if (prevTitle && (STATE.selectedTimelineScanId === scan.scan_id || STATE.activeScanId === scan.scan_id)) {
        prevTitle.textContent = savedName;
      }
      const rightTitle = document.getElementById("rightPreviewScanTitle");
      if (rightTitle && (STATE.selectedTimelineScanId === scan.scan_id || STATE.activeScanId === scan.scan_id)) {
        rightTitle.textContent = `${savedName} (${scan.capture_date})`;
      }
      document.querySelectorAll(`#siteTimelineTilesTrack .gs-timeline-tile[data-scan-id="${scan.scan_id}"] .gs-tile-name`).forEach((el) => {
        el.textContent = savedName;
        el.title = savedName;
      });
      populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);
      renderMapClusters();
      closeModal("renameScanModal");
      showToast(`Saved scan name: ${savedName}`);
    } catch (err) {
      showToast(`Failed to save scan name: ${err.message}`);
    }
  }

  document.getElementById("btnRenamePreviewScan")?.addEventListener("click", () => {
    openRenameScanModal(STATE.selectedTimelineScanId || STATE.activeScanId);
  });
  document.getElementById("previewScanTitle")?.addEventListener("dblclick", () => {
    if (!STATE.shareToken) openRenameScanModal(STATE.selectedTimelineScanId || STATE.activeScanId);
  });
  document.getElementById("btnRenameStudioScan")?.addEventListener("click", () => {
    openRenameScanModal(STATE.activeScanId);
  });
  document.getElementById("btnResetScanNameToFile")?.addEventListener("click", () => {
    const scan = STATE.scans.find((s) => s.scan_id === _renamingScanId);
    const inp = document.getElementById("renameScanInput");
    if (scan && inp) {
      inp.value = getScanDefaultFileName(scan);
      inp.focus();
    }
  });
  document.getElementById("btnConfirmSaveScanName")?.addEventListener("click", saveRenamedScan);
  document.getElementById("renameScanInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveRenamedScan();
    }
  });

  let _deletingScanId = "";
  let _cachedBinScans = [];

  function updateRecycleBinBadges(count) {
    const n = Math.max(0, Number(count) || 0);
    const topBadge = document.getElementById("topRecycleBinBadge");
    if (topBadge) {
      topBadge.textContent = String(n);
      topBadge.style.display = n > 0 ? "inline-block" : "none";
    }
    const tlBadge = document.getElementById("timelineRecycleBinBadge");
    if (tlBadge) {
      tlBadge.textContent = String(n);
      tlBadge.style.display = n > 0 ? "inline-block" : "none";
    }
    const studioBadge = document.getElementById("studioRecycleBinBadge");
    if (studioBadge) {
      studioBadge.textContent = String(n);
      studioBadge.style.display = n > 0 ? "inline-block" : "none";
    }
    const modalPill = document.getElementById("recycleBinModalCountPill");
    if (modalPill) {
      modalPill.textContent = `${n} Scan${n === 1 ? "" : "s"}`;
    }
    const btnClear = document.getElementById("btnClearAllBinScans");
    if (btnClear) {
      btnClear.disabled = n === 0;
      btnClear.style.opacity = n === 0 ? "0.5" : "1";
    }
  }

  function openDeleteScanModal(scanId) {
    if (!getCurrentUserRoleInfo().canEditNames) {
      showToast("Only Editor, Admin, or Owner accounts can move scans to the Bin.");
      return;
    }
    const targetId = scanId || STATE.selectedTimelineScanId || STATE.activeScanId;
    const scan = STATE.scans.find((s) => s.scan_id === targetId) || STATE.activeScan;
    if (!scan) {
      showToast("No scan selected to move to the Bin.");
      return;
    }
    _deletingScanId = scan.scan_id;
    const nameEl = document.getElementById("deleteScanTargetName");
    const metaEl = document.getElementById("deleteScanTargetMeta");
    const fileBase = getScanDefaultFileName(scan);
    if (nameEl) nameEl.textContent = scan.name || fileBase;
    if (metaEl) {
      metaEl.textContent = `Site: ${scan.project_group || "Site"} · Date: ${scan.capture_date || "—"} · ID: ${scan.scan_id}`;
    }
    openModal("deleteScanModal");
  }

  function applyUpdatedCatalogState(res, preferredGroup = "", preferredScanId = "") {
    if (Array.isArray(res.scans)) {
      STATE.scans = res.scans;
    }
    if (Array.isArray(res.projects)) {
      STATE.projects = res.projects;
    }
    if (typeof res.bin_scans_count === "number") {
      updateRecycleBinBadges(res.bin_scans_count);
    } else if (Array.isArray(res.bin_scans)) {
      updateRecycleBinBadges(res.bin_scans.length);
    }
    try {
      localStorage.setItem(
        "gs_last_catalog_v1",
        JSON.stringify({ scans: STATE.scans, projects: STATE.projects })
      );
    } catch (_) {}

    const targetGroup = preferredGroup || STATE.activeProjectGroup;
    const remainingInGroup = STATE.scans.filter((s) => s.project_group === targetGroup);
    const chosenById = preferredScanId ? STATE.scans.find((s) => s.scan_id === preferredScanId) : null;
    const nextScan = chosenById || remainingInGroup[0] || STATE.scans[0] || null;
    const nextGroup = nextScan ? nextScan.project_group : "";
    const nextId = nextScan ? nextScan.scan_id : "";

    STATE.activeProjectGroup = nextGroup;
    STATE.activeScanId = nextId;
    STATE.activeScan = nextScan;
    STATE.selectedTimelineScanId = nextId;

    populateProjectScanDropdowns(nextGroup, nextId);
    renderMapClusters();
    if (nextGroup) {
      openSiteTimeline(nextGroup, nextId);
    }
    if (STATE.activeView === "studio" && nextId) {
      switchView("studio", nextId);
    } else if (STATE.activeView === "studio" && !nextId) {
      switchView("map");
    }
  }

  async function confirmDeleteScan() {
    const scan = STATE.scans.find((s) => s.scan_id === _deletingScanId);
    if (!scan) {
      closeModal("deleteScanModal");
      return;
    }
    const btn = document.getElementById("btnConfirmDeleteScan");
    const origText = btn ? btn.textContent : "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Moving to Bin...";
    }
    try {
      const deletedName = scan.name || scan.scan_id;
      const deletedGroup = scan.project_group;
      const res = await apiPost("/api/scans/delete", {
        scan_id: scan.scan_id,
        actor_name: STATE.currentUser?.name || STATE.currentUser?.email || "User",
      });
      if (!Array.isArray(res.scans)) {
        res.scans = STATE.scans.filter((s) => s.scan_id !== scan.scan_id);
      }
      applyUpdatedCatalogState(res, deletedGroup, "");
      closeModal("deleteScanModal");
      showToast(`Moved scan to Recycle Bin: ${deletedName}`);
    } catch (err) {
      showToast(`Failed to move scan to Bin: ${err.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = origText || "Move to Bin (移至回收桶)";
      }
    }
  }

  function updateBinSelectionActionState() {
    const boxes = Array.from(document.querySelectorAll("#recycleBinListContainer .chk-bin-scan-item"));
    const checked = boxes.filter((b) => b.checked);
    const countEl = document.getElementById("recycleBinSelectedCount");
    if (countEl) countEl.textContent = String(checked.length);
    const allChk = document.getElementById("chkSelectAllBinScans");
    if (allChk) {
      allChk.checked = boxes.length > 0 && checked.length === boxes.length;
      allChk.indeterminate = checked.length > 0 && checked.length < boxes.length;
      allChk.disabled = boxes.length === 0;
    }
    const btnRestore = document.getElementById("btnRestoreSelectedBinScans");
    const btnPurge = document.getElementById("btnPurgeSelectedBinScans");
    if (btnRestore) btnRestore.disabled = checked.length === 0;
    if (btnPurge) btnPurge.disabled = checked.length === 0;
  }

  function renderRecycleBinItems(items) {
    _cachedBinScans = Array.isArray(items) ? items : [];
    updateRecycleBinBadges(_cachedBinScans.length);
    const roleInfo = getCurrentUserRoleInfo();
    const canPurge = Boolean(roleInfo.canManageUsers);
    const btnPurgeSel = document.getElementById("btnPurgeSelectedBinScans");
    const btnClearAll = document.getElementById("btnClearAllBinScans");
    if (btnPurgeSel) btnPurgeSel.style.display = canPurge ? "inline-flex" : "none";
    if (btnClearAll) btnClearAll.style.display = canPurge ? "inline-flex" : "none";
    const footerEl = document.getElementById("recycleBinStatusFooter");
    if (footerEl) {
      footerEl.textContent = canPurge
        ? "Original backups & deleted scans can be restored anytime · Permanent delete removes files from disk."
        : "Original backups & deleted scans can be restored anytime (Permanent delete requires Admin / Owner).";
    }
    const listEl = document.getElementById("recycleBinListContainer");
    if (!listEl) return;
    if (_cachedBinScans.length === 0) {
      listEl.innerHTML = `
        <div style="padding:32px 16px;text-align:center;color:var(--ui-text-muted);font-size:12.5px;border:1px dashed var(--ui-border);border-radius:8px;">
          Recycle Bin is empty (回收桶目前沒有掃描備份或檔案).
        </div>
      `;
      updateBinSelectionActionState();
      return;
    }

    listEl.innerHTML = "";
    _cachedBinScans.forEach((item) => {
      const sid = String(item.scan_id || "");
      const safeName = escapeHtml(item.name || sid);
      const safeGroup = escapeHtml(item.project_group || "Site");
      const safeDate = escapeHtml(item.capture_date || "—");
      const safeActor = escapeHtml(item.trashed_by_name || item.trashed_by_email || "User");
      const sizeMb = item.size_bytes ? `${(Number(item.size_bytes) / (1024 * 1024)).toFixed(1)} MB` : "—";
      const trashedTime = item.trashed_at
        ? new Date(Number(item.trashed_at) * 1000).toLocaleString("zh-TW", { hour12: false })
        : "";
      const thumbSrc = item.thumbnail_url || `/api/scans/${encodeURIComponent(sid)}/thumbnail`;
      const isBackup = Boolean(item.is_edit_backup || /\((Original|Pre-Merge) Backup\)/i.test(String(item.name || "")));

      const row = document.createElement("div");
      row.className = "gs-bin-item-row recycle-bin-item";
      row.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:9px 12px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-bg-elevated);";
      row.innerHTML = `
        <label style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer;">
          <input type="checkbox" class="chk-bin-scan-item" data-scan-id="${escapeHtml(sid)}" style="accent-color:#0284c7;width:15px;height:15px;flex-shrink:0;" />
          <img src="${thumbSrc}" alt="${safeName}" onerror="this.style.display='none'" style="width:52px;height:36px;object-fit:cover;border-radius:5px;border:1px solid var(--ui-border);flex-shrink:0;background:#0f172a;" />
          <div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              <span style="font-size:12.5px;font-weight:700;color:var(--ui-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safeName}</span>
              ${
                isBackup
                  ? `<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:rgba(16,185,129,0.14);color:#10b981;">Backup · 原始備份</span>`
                  : ""
              }
              <span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:var(--ui-accent-soft);color:var(--ui-accent);">${safeGroup}</span>
              <span style="font-size:10.5px;color:var(--ui-text-secondary);font-family:var(--mono);">${safeDate} · ${item.image_count || 0} imgs · ${sizeMb}</span>
            </div>
            <div style="font-size:10.5px;color:var(--ui-text-muted);word-break:break-word;">
              ${isBackup ? "Archived by" : "Deleted by"} ${safeActor}${trashedTime ? ` · ${escapeHtml(trashedTime)}` : ""} · ID: <code>${escapeHtml(sid)}</code>
            </div>
          </div>
        </label>
        <div class="gs-bin-item-actions recycle-bin-item-actions" style="display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap;">
          <button type="button" class="btn-xs primary" data-bin-restore="${escapeHtml(sid)}" title="Restore this scan back to Map & Studio">
            ↩ Restore (還原)
          </button>
          ${
            canPurge
              ? `<button type="button" class="btn-xs" data-bin-purge="${escapeHtml(sid)}" style="color:#ef4444;border-color:rgba(239,68,68,0.4);" title="Permanently delete this scan and its files from disk">
                  🗑 Delete Forever
                </button>`
              : ""
          }
        </div>
      `;

      row.querySelector(".chk-bin-scan-item")?.addEventListener("change", updateBinSelectionActionState);
      row.querySelector("[data-bin-restore]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        restoreBinScans([sid]);
      });
      row.querySelector("[data-bin-purge]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        purgeBinScans([sid], false);
      });
      listEl.appendChild(row);
    });
    updateBinSelectionActionState();
  }

  async function refreshRecycleBinList() {
    try {
      const res = await apiGet("/api/scans/bin");
      renderRecycleBinItems(res.bin_scans || []);
    } catch (err) {
      showToast(`Failed to load Recycle Bin: ${err.message}`);
    }
  }

  async function openRecycleBinModal() {
    const rInfo = getCurrentUserRoleInfo();
    if (!rInfo.canEditNames && !rInfo.canManageUsers) {
      showToast("Only Editor, Admin, or Owner accounts can access the Recycle Bin.");
      return;
    }
    closeModal("deleteScanModal");
    openModal("recycleBinModal");
    await refreshRecycleBinList();
  }

  async function restoreBinScans(scanIds) {
    const rInfo = getCurrentUserRoleInfo();
    if (!rInfo.canEditNames && !rInfo.canManageUsers) {
      showToast("Only Editor, Admin, or Owner accounts can restore scans from the Bin.");
      return;
    }
    if (!Array.isArray(scanIds) || scanIds.length === 0) return;
    try {
      const res = await apiPost("/api/scans/bin/restore", { scan_ids: scanIds });
      renderRecycleBinItems(res.bin_scans || []);
      const firstRestored = Array.isArray(res.restored) && res.restored[0] ? res.restored[0] : null;
      applyUpdatedCatalogState(
        res,
        firstRestored ? firstRestored.project_group : STATE.activeProjectGroup,
        firstRestored ? firstRestored.scan_id : STATE.activeScanId
      );
      showToast(`Restored ${scanIds.length} scan${scanIds.length === 1 ? "" : "s"} from Recycle Bin`);
    } catch (err) {
      showToast(`Failed to restore from Bin: ${err.message}`);
    }
  }

  async function purgeBinScans(scanIds, clearAll = false) {
    if (!getCurrentUserRoleInfo().canManageUsers) {
      showToast("Only Admin or Owner accounts can permanently delete scans from the Bin.");
      return;
    }
    try {
      const res = await apiPost("/api/scans/bin/purge", {
        scan_ids: scanIds || [],
        clear_all: Boolean(clearAll),
      });
      renderRecycleBinItems(res.bin_scans || []);
      applyUpdatedCatalogState(res, STATE.activeProjectGroup, STATE.activeScanId);
      const purgedCount = Array.isArray(res.purged_scan_ids) ? res.purged_scan_ids.length : (scanIds || []).length;
      showToast(
        clearAll
          ? `Emptied Recycle Bin (${purgedCount} scan${purgedCount === 1 ? "" : "s"} permanently deleted)`
          : `Permanently deleted ${purgedCount} scan${purgedCount === 1 ? "" : "s"} from Bin`
      );
    } catch (err) {
      showToast(`Failed to permanently delete from Bin: ${err.message}`);
    }
  }

  document.getElementById("btnDeletePreviewScan")?.addEventListener("click", () => {
    openDeleteScanModal(STATE.selectedTimelineScanId || STATE.activeScanId);
  });
  document.getElementById("btnDeleteStudioScan")?.addEventListener("click", () => {
    openDeleteScanModal(STATE.activeScanId);
  });
  document.getElementById("btnConfirmDeleteScan")?.addEventListener("click", confirmDeleteScan);
  document.getElementById("btnOpenRecycleBin")?.addEventListener("click", openRecycleBinModal);
  document.getElementById("btnTimelineRecycleBin")?.addEventListener("click", openRecycleBinModal);
  document.getElementById("btnStudioRecycleBin")?.addEventListener("click", openRecycleBinModal);
  document.getElementById("btnOpenBinFromDeleteModal")?.addEventListener("click", openRecycleBinModal);
  document.getElementById("chkSelectAllBinScans")?.addEventListener("change", (ev) => {
    const checked = Boolean(ev.target.checked);
    document.querySelectorAll("#recycleBinListContainer .chk-bin-scan-item").forEach((b) => {
      b.checked = checked;
    });
    updateBinSelectionActionState();
  });
  document.getElementById("btnRestoreSelectedBinScans")?.addEventListener("click", () => {
    const ids = Array.from(document.querySelectorAll("#recycleBinListContainer .chk-bin-scan-item:checked"))
      .map((b) => b.getAttribute("data-scan-id"))
      .filter(Boolean);
    restoreBinScans(ids);
  });
  document.getElementById("btnPurgeSelectedBinScans")?.addEventListener("click", () => {
    const ids = Array.from(document.querySelectorAll("#recycleBinListContainer .chk-bin-scan-item:checked"))
      .map((b) => b.getAttribute("data-scan-id"))
      .filter(Boolean);
    purgeBinScans(ids, false);
  });
  document.getElementById("btnClearAllBinScans")?.addEventListener("click", () => {
    purgeBinScans([], true);
  });

  // ============================================================================
  // 1C. RENAME SITE (PROJECT GROUP) MODAL & RE-RUN SCAN FROM ORIGINAL PHOTOS MODAL
  // ============================================================================
  let _renamingSiteGroup = "";

  function openRenameSiteModal(projectGroup) {
    if (!getCurrentUserRoleInfo().canEditNames) {
      showToast("Only Editor, Admin, or Owner accounts can rename sites.");
      return;
    }
    const targetGroup =
      projectGroup ||
      STATE.activeProjectGroup ||
      (STATE.activeScan && STATE.activeScan.project_group) ||
      (STATE.scans[0] && STATE.scans[0].project_group) ||
      "";
    if (!targetGroup) return;
    _renamingSiteGroup = targetGroup;
    const siteScans = STATE.scans.filter((s) => s.project_group === targetGroup);
    const zhName = (siteScans[0] && siteScans[0].project_name_zh) || targetGroup;
    const subEl = document.getElementById("renameSiteModalSub");
    if (subEl) {
      subEl.textContent = `Current Site: ${targetGroup} (${siteScans.length} Scan${siteScans.length === 1 ? "" : "s"})`;
    }
    const grpInp = document.getElementById("renameSiteGroupInput");
    const zhInp = document.getElementById("renameSiteZhInput");
    if (grpInp) grpInp.value = targetGroup;
    if (zhInp) zhInp.value = zhName;
    openModal("renameSiteModal");
    setTimeout(() => {
      if (grpInp) {
        grpInp.focus();
        grpInp.select();
      }
    }, 40);
  }

  async function saveRenamedSite() {
    if (!_renamingSiteGroup) return;
    const grpInp = document.getElementById("renameSiteGroupInput");
    const zhInp = document.getElementById("renameSiteZhInput");
    const newGroup = String(grpInp ? grpInp.value : "").trim();
    const newZh = String(zhInp ? zhInp.value : "").trim() || newGroup;
    if (!newGroup) {
      showToast("Site name cannot be empty");
      return;
    }
    try {
      const res = await apiPost("/api/projects/rename", {
        old_project_group: _renamingSiteGroup,
        new_project_group: newGroup,
        new_project_name_zh: newZh,
      });
      if (Array.isArray(res.scans)) STATE.scans = res.scans;
      if (Array.isArray(res.projects)) STATE.projects = res.projects;
      STATE.activeProjectGroup = newGroup;
      if (STATE.activeScan) {
        STATE.activeScan = STATE.scans.find((s) => s.scan_id === STATE.activeScan.scan_id) || STATE.activeScan;
      }
      const tlTitle = document.getElementById("timelineSiteTitle");
      if (tlTitle) tlTitle.textContent = newGroup;
      const popTitle = document.getElementById("popoverGroupTitle");
      if (popTitle) popTitle.textContent = newGroup;
      populateProjectScanDropdowns(newGroup, STATE.activeScanId);
      renderMapClusters();
      if (STATE.siteTimelineOpen) {
        openSiteTimeline(newGroup, STATE.selectedTimelineScanId || STATE.activeScanId);
      }
      closeModal("renameSiteModal");
      showToast(`Renamed site "${_renamingSiteGroup}" → "${newGroup}" (${res.updated_count || 1} scans updated)`);
    } catch (err) {
      showToast(`Failed to rename site: ${err.message}`);
    }
  }

  ["btnRenameMapSite", "btnRenamePopoverSite", "btnRenameTimelineSite", "btnRenameStudioSite"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", () => {
      const mapSel = document.getElementById("mapProjectSelect")?.value;
      const grp =
        id === "btnRenameMapSite" && mapSel && mapSel !== "__all__"
          ? mapSel
          : STATE.activeProjectGroup;
      openRenameSiteModal(grp);
    });
  });
  document.getElementById("timelineSiteTitle")?.addEventListener("dblclick", () => {
    if (!STATE.shareToken) openRenameSiteModal(STATE.activeProjectGroup);
  });
  document.getElementById("popoverGroupTitle")?.addEventListener("dblclick", () => {
    if (!STATE.shareToken) openRenameSiteModal(STATE.activeProjectGroup);
  });
  document.getElementById("btnConfirmSaveSiteName")?.addEventListener("click", saveRenamedSite);
  document.getElementById("renameSiteGroupInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveRenamedSite();
    }
  });

  // Re-run Scan from Original Photos Modal
  let _rerunTargetScanId = "";

  function readRerunModalSettings() {
    return {
      mesh_pipeline: document.getElementById("rerunSelMeshPipeline")?.value || "FixedSize",
      mesh_quality: document.getElementById("rerunSelMeshQuality")?.value || "High",
      vertex_density: document.getElementById("rerunSelVertexDensity")?.value || "High",
      texture_size: Number(document.getElementById("rerunSelTextureSize")?.value || 4096),
      model_simplification: document.getElementById("rerunSelSimplification")?.value || "Conservative",
      deghosting: document.getElementById("rerunSelDeghosting")?.value || "Weak",
      export_lod: Number(document.getElementById("rerunInpExportLod")?.value || 13),
      skyless: Boolean(document.getElementById("rerunChkSkyless")?.checked),
      use_roi: Boolean(document.getElementById("rerunChkUseRoi")?.checked),
    };
  }

  async function updateRerunGstPreview() {
    if (!_rerunTargetScanId) return;
    try {
      const settings = readRerunModalSettings();
      const res = await apiPost("/api/queue/preview-gst", {
        scan_id: _rerunTargetScanId,
        settings,
      });
      const codeEl = document.getElementById("rerunGstPreviewCode");
      if (codeEl && res.gst_script) {
        codeEl.textContent = res.gst_script;
      }
    } catch (err) {
      const codeEl = document.getElementById("rerunGstPreviewCode");
      if (codeEl) codeEl.textContent = `// Preview error: ${err.message}`;
    }
  }

  function openRerunScanModal(scanId) {
    if (!getCurrentUserRoleInfo().canRunWorkflows) {
      showToast("Only Editor, Admin, or Owner accounts can run or re-run scans on the PC.");
      return;
    }
    const targetId = scanId || STATE.selectedTimelineScanId || STATE.activeScanId;
    const scan = STATE.scans.find((s) => s.scan_id === targetId) || STATE.activeScan;
    if (!scan) return;
    _rerunTargetScanId = scan.scan_id;
    const nameEl = document.getElementById("rerunScanInfoName");
    if (nameEl) nameEl.textContent = `${scan.name} (${scan.project_group})`;
    const srcEl = document.getElementById("rerunScanInfoSource");
    if (srcEl) {
      const pCount = scan.image_count || scan.total_photos || 100;
      const srcPath = scan.source_zip_path || `${scan.project_dir || "C:\\GatheringScans\\" + scan.scan_id}\\inputs`;
      srcEl.textContent = `Original Photos Source: ${srcPath} (${pCount} RTK photos)`;
    }
    openModal("rerunScanModal");
    updateRerunGstPreview();
  }

  async function confirmRerunScan() {
    if (!_rerunTargetScanId) return;
    const settings = readRerunModalSettings();
    const forceFromPhotos = Boolean(document.getElementById("rerunChkForceFromPhotos")?.checked);
    const runImmediately = Boolean(document.getElementById("rerunChkRunImmediately")?.checked);
    const msgEl = document.getElementById("rerunModalStatusMsg");
    if (msgEl) msgEl.textContent = "Submitting re-run job to PIX4Dmatic 2.11.0...";
    try {
      const res = await apiPost("/api/scans/rerun", {
        scan_id: _rerunTargetScanId,
        force_from_photos: forceFromPhotos,
        force_next: true,
        run_immediately: runImmediately,
        settings,
      });
      closeModal("rerunScanModal");
      showToast(
        runImmediately
          ? `Launched PIX4Dmatic re-run from original photos (${res.original_photos_count || 100} imgs, ${settings.mesh_quality}, ${settings.texture_size}px)`
          : `Queued ${res.scan?.name || _rerunTargetScanId} for re-run from original photos (${settings.mesh_quality}, ${settings.texture_size}px)`
      );
      await refreshScansCatalog();
    } catch (err) {
      if (msgEl) msgEl.textContent = `Error: ${err.message}`;
      showToast(`Re-run Error: ${err.message}`);
    }
  }

  document.getElementById("btnRerunPreviewScan")?.addEventListener("click", () => {
    openRerunScanModal(STATE.selectedTimelineScanId || STATE.activeScanId);
  });
  document.getElementById("btnRerunStudioScan")?.addEventListener("click", () => {
    openRerunScanModal(STATE.activeScanId);
  });
  document.getElementById("btnConfirmRerunScan")?.addEventListener("click", confirmRerunScan);
  [
    "rerunSelMeshPipeline",
    "rerunSelMeshQuality",
    "rerunSelVertexDensity",
    "rerunSelTextureSize",
    "rerunSelSimplification",
    "rerunSelDeghosting",
    "rerunInpExportLod",
    "rerunChkSkyless",
    "rerunChkUseRoi",
  ].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", updateRerunGstPreview);
  });
  window.openRerunScanModal = openRerunScanModal;
  window.openRenameSiteModal = openRenameSiteModal;

  function closeSiteTimeline() {
    STATE.siteTimelineOpen = false;
    document.getElementById("siteTimelineSplitView")?.classList.remove("active");
    syncPreviewRendererContainer();
    if (gsMap && gsMap.drawMap) gsMap.drawMap();
  }

  document.getElementById("btnCloseSiteTimeline")?.addEventListener("click", closeSiteTimeline);

  document.getElementById("btnEnlargePreviewToStudio")?.addEventListener("click", () => {
    const targetScanId = STATE.selectedTimelineScanId || STATE.activeScanId;
    switchView("studio", targetScanId);
  });

  document.getElementById("btnEnlargeRightPreview")?.addEventListener("click", () => {
    const targetScanId = STATE.selectedTimelineScanId || STATE.activeScanId;
    switchView("studio", targetScanId);
  });

  document.getElementById("btnRightPreviewResetCamera")?.addEventListener("click", framePreviewCamera);

  document.getElementById("btnStudioBackToTimeline")?.addEventListener("click", () => {
    openSiteTimeline(STATE.activeProjectGroup, STATE.activeScanId, true);
  });

  document.getElementById("btnCapturePreviewScreenshot")?.addEventListener("click", () => {
    captureAndPersistScanScreenshot(STATE.selectedTimelineScanId || STATE.activeScanId, previewThree, true);
  });

  document.getElementById("btnPreviewResetCamera")?.addEventListener("click", framePreviewCamera);

  document.getElementById("previewBrightnessSlider")?.addEventListener("input", (e) => {
    const b = Math.max(0.1, Math.min(4.0, parseFloat(e.target.value) || 1.0));
    const lbl = document.getElementById("lblPreviewBrightness");
    if (lbl) lbl.textContent = `${b.toFixed(1)}x`;
    setStudioScanBrightness(b);
    if (previewThree) {
      [previewThree.modelPivot, previewThree.fallbackGroup].forEach((grp) => {
        if (!grp) return;
        grp.traverse((child) => {
          if (child.isMesh && child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => applyBrightnessToMaterial(m, b));
          }
        });
      });
    }
  });

  document.getElementById("btnTimelineCompare")?.addEventListener("click", () => {
    const siteScans = STATE.scans.filter((s) => s.project_group === STATE.activeProjectGroup);
    const s1 = siteScans.find((s) => s.scan_id === STATE.selectedTimelineScanId) || siteScans[0] || STATE.scans[0];
    const s2 = siteScans.find((s) => s.scan_id !== s1.scan_id) || s1;
    if (s1 && s2) launchMultiDateCompare(s2.scan_id, s1.scan_id);
  });

  document.getElementById("btnTimelineShare")?.addEventListener("click", () => {
    openSharingModal("group", STATE.activeProjectGroup);
  });

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
      if (!mat.map.anisotropy || mat.map.anisotropy < 8) {
        mat.map.anisotropy = 8;
        mat.map.needsUpdate = true;
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
        return `GS_ScanShader_v5_${mat.type || "Standard"}_${mat.map ? "1" : "0"}_${mat.vertexColors ? "1" : "0"}`;
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
           vec3 litPhoto = basePhoto * uBrightness;
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
      0.1,
      10000
    );
    camera.position.set(45, 38, 55);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.localClippingEnabled = true;
    container.appendChild(renderer.domElement);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
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
        showToast("已瞬移至目標位置 (Teleported)");
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
        if (document.pointerLockElement !== renderer.domElement && (e.button === 0 || e.button === 2 || e.pointerType === "touch")) {
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
        return;
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
      if (handleGizmoPointerUp(e)) return;
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
      if (STATE.fpMode.active) {
        if (document.pointerLockElement === renderer.domElement) {
          // Handled via document mousemove for raw movementX / movementY
          return;
        }
        const isTrackedTouch = e.pointerType === "touch" && STATE.fpMode.lookPointerId === e.pointerId;
        const isSamePointer = STATE.fpMode.lookPointerId == null || STATE.fpMode.lookPointerId === e.pointerId;
        if (STATE.fpMode.dragLooking && isSamePointer && ((e.buttons & 3) !== 0 || isTrackedTouch)) {
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
      // Do not run hover raycasts while orbiting/panning with mouse buttons held down
      if ((e.buttons & 7) !== 0) return;

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
          (STATE.activeTool === "profile" && STATE.measurePoints.length === 1)) &&
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
      renderer.render(scene, camera);
      update2DBadgePositions();
    };
    requestAnimationFrame(animate);

    return studioThree;
  }

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
    const bustCache = Boolean(opts && opts.bustCache);

    if (STATE.fpMode?.active && typeof exitFirstPersonMode === "function") {
      exitFirstPersonMode(true);
    }
    if (STATE.multiAlign?.active && typeof exitMultiScanAlignMode === "function") {
      exitMultiScanAlignMode(false);
    }

    STATE.activeScanId = scan.scan_id;
    STATE.activeScan = scan;
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
        pickedEl.textContent = `Local Origin · Click 3D surface to inspect`;
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
    STATE.categorizeOverlayVisible = false;
    if (typeof clearCategorizeVisualsOnly === "function") {
      clearCategorizeVisualsOnly();
    }
    if (typeof syncCategorizeVisibilityUI === "function") {
      syncCategorizeVisibilityUI();
    }
    if (typeof preloadSavedCategorizationForScan === "function") {
      preloadSavedCategorizationForScan(scan.scan_id, scan, { renderWhenLoaded: false });
    }
    if (typeof resetStagedEditsForScan === "function") {
      resetStagedEditsForScan(scan);
    }

    const prevTilesCenter =
      preserveCamera && Array.isArray(studioThree.tilesCenter) ? studioThree.tilesCenter.slice() : null;
    const prevCamPos = preserveCamera && studioThree.camera ? studioThree.camera.position.clone() : null;
    const prevCamTarget = preserveCamera && studioThree.controls ? studioThree.controls.target.clone() : null;

    // Teardown previous tilesRenderer / mesh
    if (studioThree.tilesRenderer) {
      studioThree.modelPivot.remove(studioThree.tilesRenderer.group);
      studioThree.tilesRenderer.dispose();
      studioThree.tilesRenderer = null;
    }
    while (studioThree.modelPivot.children.length > 0) {
      studioThree.modelPivot.remove(studioThree.modelPivot.children[0]);
    }
    studioThree.modelPivot.rotation.set(0, 0, 0);
    studioThree.modelPivot.updateMatrixWorld(true);
    studioThree.tilesCenter = [0, 0, 0];
    studioThree.tileUpMatrix = new THREE.Matrix4();
    if (studioThree.fallbackGroup) studioThree.fallbackGroup.visible = false;

    startScanLoader(studioThree, "studio", scan.name);

    let streamUrl = scan.stream_url || `/stream/${scan.scan_id}/tileset.json`;
    if (bustCache) {
      const baseNoQ = streamUrl.split("?")[0];
      streamUrl = `${baseNoQ}?v=${scan.tileset_version || Date.now()}`;
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
              mats.forEach((m) => applyBrightnessToMaterial(m, STATE.scanBrightness));
            }
          });
          studioThree.modelPivot.add(model);
          studioThree.boundingSphere = sphere;
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
        studioThree._tilesetReady = true;
        studioThree._tilesetReadyMs = performance.now();
        studioThree._maxPct = Math.max(studioThree._maxPct || 0, 22);
        updateScanLoader("studio", true, studioThree._maxPct, "Streaming 3D tiles...");
        const sphere = new THREE.Sphere();
        if (computeTilesetContentSphere(tr, sphere)) {
          tr.group.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
          studioThree.tilesCenter = [sphere.center.x, sphere.center.y, sphere.center.z];
          studioThree.tileUpMatrix = tr._upRotationMatrix ? tr._upRotationMatrix.clone() : new THREE.Matrix4();
          // Z-up TWD97 tilesets: rotate -90 deg on X so elevation points +Y
          studioThree.modelPivot.rotation.set(THREE.MathUtils.degToRad(270), 0, 0);
          studioThree.modelPivot.updateMatrixWorld(true);
          studioThree.boundingSphere = sphere;
          if (studioThree.grid) {
            studioThree.grid.position.y = Number.isFinite(sphere._groundOffsetY)
              ? sphere._groundOffsetY
              : -8.0;
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
        }
        studioThree.camera.updateMatrixWorld();
        tr.update();
      });

      tr.addEventListener("load-model", (ev) => {
        if (ev && ev.scene) {
          if (studioThree.fallbackGroup) studioThree.fallbackGroup.visible = false;
          ev.scene.traverse((c) => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => applyBrightnessToMaterial(m, STATE.scanBrightness));
            }
          });
          studioThree.camera.updateMatrixWorld();
          tr.update();
          if (typeof applyStagedEditsToStudioMeshes === "function" && hasStagedMeshEditsForActiveScan()) {
            applyStagedEditsToStudioMeshes(false);
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
        }
      });

      tr.errorTarget = 6.0;
      if (tr.downloadQueue) tr.downloadQueue.maxJobs = 12;
      if (tr.parseQueue) tr.parseQueue.maxJobs = 6;
      studioThree.modelPivot.add(tr.group);
      studioThree.tilesRenderer = tr;
      studioThree.camera.updateMatrixWorld();
      tr.update();
    }

    renderCommentPins3D();
  }

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
    let cx = 0, cy = 0, cz = 0;
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

    const hits = studioThree.raycaster.intersectObjects(targets, true);
    if (hits.length > 0) {
      const h0 = hits[0];
      const rawPoint = h0.point.clone();
      const p = rawPoint.clone();
      if (STATE.snapEnabled) {
        p.x = Math.round(p.x * 20) / 20;
        p.y = Math.round(p.y * 20) / 20;
        p.z = Math.round(p.z * 20) / 20;
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
      };
    }
    return null;
  }

  function pickStudio3DPoint(clientX, clientY) {
    const hit = pickStudio3DHit(clientX, clientY);
    return hit ? hit.point : null;
  }

  const _tmpZoomWorldPos = new THREE.Vector3();

  function add3DPinMarker(pt, colorHex = 0x0084ff, targetGroup = null, onAddMesh = null) {
    if (!studioThree) return null;
    const grp = targetGroup || studioThree.overlayGroup;
    const emit = typeof onAddMesh === "function" ? onAddMesh : (m) => grp.add(m);

    const sphereGeo = new THREE.SphereGeometry(1, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    const innerMesh = new THREE.Mesh(sphereGeo, sphereMat);
    innerMesh.position.copy(pt);
    innerMesh.userData.isZoomInvariantMarker = true;
    innerMesh.userData.pixelRadius = 5.5;
    innerMesh.renderOrder = 1002;
    emit(innerMesh);

    const ringGeo = new THREE.RingGeometry(0.72, 1.08, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    const outerRing = new THREE.Mesh(ringGeo, ringMat);
    outerRing.position.copy(pt);
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
    const el = document.createElement("div");
    if (options.rawHtml) {
      el.innerHTML = htmlText;
      const firstChild = el.firstElementChild;
      if (firstChild) {
        firstChild.style.position = "absolute";
        firstChild.style.pointerEvents = "none";
        if (options.isCategorize) firstChild.classList.add("is-categorize-badge");
        container.appendChild(firstChild);
        const badgeObj = {
          el: firstChild,
          worldPt: worldPt.clone(),
          offsetX: options.offsetX || 0,
          offsetY: options.offsetY || 0,
          isVolume: !!options.isVolume,
          isArea: !!options.isArea,
          isLassoHighlight: !!options.isLassoHighlight,
          isProfile: !!options.isProfile,
          isCategorize: !!options.isCategorize,
          isTempDistance: !!options.isTempDistance,
          priority: options.priority !== undefined ? Number(options.priority) : 50,
          featureId: options.featureId || "",
          isFocused: !!options.isFocused,
        };
        STATE.badges2D.push(badgeObj);
        update2DBadgePositions();
        if (!options.isTempDistance && !options.isCategorize && !options.isLassoHighlight) {
          SHARE_TELEMETRY.recordMeasurement(firstChild.textContent || "");
        }
        return badgeObj;
      }
    }
    el.className = options.isCategorize ? "measure-badge-2d is-categorize-badge" : "measure-badge-2d";
    el.style.position = "absolute";
    el.style.pointerEvents = "none";
    el.style.borderColor = borderColor;
    let finalHtml = htmlText;
    if (options.isCategorize && options.featureId && options.catKey && options.catKey !== "stockpiles") {
      finalHtml += ` <button type="button" data-cat-badge-del="${escapeHtml(options.featureId)}" data-cat-badge-type="${escapeHtml(options.catKey)}" title="刪除此分類項目 Remove ${escapeHtml(options.featureId)}" style="margin-left:5px;padding:0 4px;border:none;border-radius:4px;background:rgba(239,68,68,0.24);color:#fca5a5;cursor:pointer;font-size:10px;line-height:1.2;pointer-events:auto;">×</button>`;
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
      worldPt: worldPt.clone(),
      offsetX: options.offsetX || 0,
      offsetY: options.offsetY !== undefined ? options.offsetY : -10,
      isVolume: !!options.isVolume,
      isArea: !!options.isArea,
      isLassoHighlight: !!options.isLassoHighlight,
      isProfile: !!options.isProfile,
      isCategorize: !!options.isCategorize,
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
    if (!studioThree) return;
    const w = studioThree.renderer.domElement.clientWidth;
    const h = studioThree.renderer.domElement.clientHeight;
    const isMobile = w <= 768;
    const panelEl = document.getElementById("studioSidePanel");
    const panelOpen = Boolean(panelEl && (panelEl.classList.contains("open") || panelEl.classList.contains("active")) && !panelEl.classList.contains("hidden"));
    const panelMinimized = Boolean(panelEl && panelEl.classList.contains("mobile-minimized"));
    const rightSafeX = isMobile ? w - 8 : w - (panelOpen ? (panelEl.offsetWidth || 380) + 16 : 14);
    const leftSafeX = isMobile ? 8 : 86;
    const topSafeY = isMobile ? 74 : 68;
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
      if (!b.el || !b.worldPt) return;
      const v = b.worldPt.clone().project(studioThree.camera);
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
      if (!isCat) {
        b.el.style.display = dispMode;
        const bw = b.el.offsetWidth || 160;
        const bh = b.el.offsetHeight || 36;
        const halfW = Math.min(bw * 0.5, Math.max(16, w * 0.5 - 8));
        const halfH = bh * 0.5;
        const minX = isMobile ? Math.max(24, halfW + 8) : halfW + 8;
        const maxX = isMobile ? Math.min(w - 24, w - halfW - 8) : w - halfW - 8;
        const clampedX = Math.max(minX, Math.min(Math.max(minX, maxX), x));
        const minY = isMobile ? Math.max(82, bh + 66) : 58;
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
    studioThree.controls.enableRotate = !isFreehandLasso;
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
        ? "🔒 準星已鎖定 (Esc 解鎖滑鼠)"
        : "🎯 點擊畫面鎖定滑鼠 (或拖曳旋轉)";
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
      if (upAct) upAct.textContent = "跳躍";
      if (dnKey) dnKey.textContent = "C";
      if (dnAct) dnAct.textContent = "蹲下";
    } else {
      if (upKey) upKey.textContent = "Space/E";
      if (upAct) upAct.textContent = "上升";
      if (dnKey) dnKey.textContent = "C/Q";
      if (dnAct) dnAct.textContent = "下降";
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
          ? "🚶 步行模式 (1.68m 人眼視角 · Space 跳躍 · C 蹲下 · G 切換飛行)"
          : "🚀 自由飛行模式 (WASD 移動 · Space/E 上升 · C/Q 下降 · 滾輪調速)"
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
        showToast("🎮 第一人稱漫遊開啟 — 左下方向鍵移動 · 單指拖曳旋轉視角 · 頂部切換飛行/步行");
      } else {
        showToast("🎮 第一人稱漫遊開啟 — WASD 移動 · 滑鼠拖曳或點擊鎖定視角 · 滾輪調速 · G 切換步行/飛行");
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
      showToast("已離開第一人稱漫遊，返回環繞視角 (Orbit Mode)");
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
    "comments",
    "crop",
  ]);

  const MULTI_ALIGN_DISABLED_ELEMENT_IDS = [
    "btnDockVolume",
    "btnDockContours",
    "btnMeasureProfile",
    "btnMeasurePhotos",
    "btnDockCategorize",
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

  const MULTI_ALIGN_DISABLED_REASON =
    "Unavailable during Multi-Scan Editing — merge scans first (or exit Multi-Scan mode) / 多掃描合併編輯中暫停使用，請先合併掃描或退出多掃描模式";

  function syncMultiAlignToolAvailability() {
    const isMulti = Boolean(STATE.multiAlign?.active);
    const lockSingleScan = Boolean(STATE.shareToken && STATE.shareInfo?.scope_type === "scan");

    MULTI_ALIGN_DISABLED_ELEMENT_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (isMulti) {
        if (el.dataset.origTitle === undefined) {
          el.dataset.origTitle = el.getAttribute("title") || "";
        }
        el.setAttribute("title", MULTI_ALIGN_DISABLED_REASON);
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

  function setActiveStudioTool(toolName) {
    if (!toolName) return;
    if (STATE.multiAlign?.active && MULTI_ALIGN_DISABLED_TOOLS.has(toolName)) {
      showToast("Unavailable during Multi-Scan Editing — merge scans first (or exit Multi-Scan mode)");
      return;
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
        if (isActive && window.innerWidth <= 768 && typeof b.scrollIntoView === "function") {
          try {
            b.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
          } catch (_) {}
        }
      });
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
    STATE.measurePoints = [];
    STATE.completedMeasurements = [];
    STATE.polygonLocked = false;
    if (typeof clearLassoSelectionState === "function") {
      clearLassoSelectionState();
    }
    clearTempDistanceVisuals();
    clearAreaVisualsOnly();
    clearVolumeVisualsOnly();
    STATE.categorizeOverlayVisible = false;
    if (typeof clearCategorizeVisualsOnly === "function") {
      clearCategorizeVisualsOnly();
    }
    if (typeof syncCategorizeVisibilityUI === "function") {
      syncCategorizeVisibilityUI();
    }
    if (studioThree) {
      while (studioThree.overlayGroup.children.length > 0) {
        studioThree.overlayGroup.remove(studioThree.overlayGroup.children[0]);
      }
    }
    const container = document.getElementById("studioOverlay2D");
    if (container) container.innerHTML = "";
    STATE.badges2D = [];
  }

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
    const lineMat = new THREE.LineBasicMaterial({ color: 0x0084ff, linewidth: 2, depthTest: false });
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
      new THREE.LineBasicMaterial({ color: 0xef4444, linewidth: 2, depthTest: false })
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
      new THREE.LineBasicMaterial({ color: 0x10b981, linewidth: 2, depthTest: false })
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
      new THREE.LineBasicMaterial({ color: 0x3b82f6, linewidth: 2, depthTest: false })
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

    if (!p3) {
      const horiz1 = Math.hypot(p2.x - p1.x, p2.z - p1.z);
      const slopePct = horiz1 > 0.05 ? (Math.abs(p2.y - p1.y) / horiz1) * 100 : 0;
      const v2Locked = isTemp && (STATE.measurePoints || []).length >= 2;
      const subPrompt = v2Locked
        ? `頂點已鎖定 · 移動滑鼠預覽夾角`
        : `坡度 ${slopePct.toFixed(1)}% · 點擊確認頂點 P2`;
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

    // Compute 3D interior angle and 2D horizontal plan angle at Vertex P2
    const u1 = p1.clone().sub(p2);
    const u2 = p3.clone().sub(p2);
    const l1Safe = Math.max(1e-6, u1.length());
    const l2Safe = Math.max(1e-6, u2.length());
    u1.divideScalar(l1Safe);
    u2.divideScalar(l2Safe);

    const cos3D = Math.max(-1, Math.min(1, u1.dot(u2)));
    const thetaRad = Math.acos(cos3D);
    const deg3D = THREE.MathUtils.radToDeg(thetaRad);

    const h1x = p1.x - p2.x, h1z = p1.z - p2.z;
    const h2x = p3.x - p2.x, h2z = p3.z - p2.z;
    const hl1 = Math.hypot(h1x, h1z);
    const hl2 = Math.hypot(h2x, h2z);
    let degHoriz = deg3D;
    if (hl1 > 0.02 && hl2 > 0.02) {
      const cosH = Math.max(-1, Math.min(1, (h1x * h2x + h1z * h2z) / (hl1 * hl2)));
      degHoriz = THREE.MathUtils.radToDeg(Math.acos(cosH));
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

    const horizSub = `<span class="autodesk-sub-pill">水平 ${degHoriz.toFixed(1)}°</span>`;
    add2DBadge(
      bisectorPt,
      `<div class="autodesk-flex-badge autodesk-angle-badge"><span>${deg3D.toFixed(1)}°</span>${horizSub}</div>`,
      "#f59e0b",
      { rawHtml: true, offsetY: -10, isTempDistance: isTemp }
    );

    updateZoomInvariantElements();
  }

  // Interactive Hover & Pinned Coordinate Visuals
  function renderCoordinateVisuals(pt, existingMeas = null) {
    if (!studioThree || !pt) return;
    const isTemp = !existingMeas;
    if (isTemp) {
      clearTempDistanceVisuals();
    }
    const targetPt = existingMeas ? existingMeas.pt : pt;
    const twd = existingMeas?.twd || localToTwd97(targetPt);
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

    const labelPrefix = existingMeas?.label ? `<span style="color:#34d399;font-weight:800;">${escapeHtml(existingMeas.label)}</span>` : `<span style="color:#38bdf8;">📍</span>`;
    add2DBadge(
      targetPt,
      `<div class="autodesk-flex-badge autodesk-coord-badge ${isTemp ? "" : "pinned"}">${labelPrefix}<span>${axX} ${twd.e.toFixed(2)} · ${axY} ${twd.n.toFixed(2)} · ${axZ} ${zSign}${twd.h.toFixed(2)} m</span></div>`,
      isTemp ? "#38bdf8" : "#10b981",
      { rawHtml: true, offsetY: -22, isTempDistance: isTemp }
    );

    updateZoomInvariantElements();
  }

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

    // Keep 100% of triangles (triStride = 1) up to 2.8M tris so multi-scan merged models never get swiss-cheese gaps!
    const triStride = totalTris > 2800000 ? 2 : 1;
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
    const cellSize = Math.max(0.85, Math.min(2.6, spanMax / 165));
    const invCell = 1.0 / cellSize;
    const gridW = Math.max(4, Math.min(200, Math.ceil((maxX - minX) * invCell)));
    const gridH = Math.max(4, Math.min(200, Math.ceil((maxZ - minZ) * invCell)));
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
      add2DBadge(
        info.originPt,
        `<div class="autodesk-flex-badge autodesk-laser-badge ${isTemp ? "" : "pinned"}">🔴 雷射高程 H ${twd.h >= 0 ? "+" : ""}${twd.h.toFixed(2)} m <span class="autodesk-sub-pill">坡度 ${(info.slopeDeg || 0).toFixed(1)}°</span></div>`,
        "#e11d48",
        { rawHtml: true, offsetY: isTemp ? -24 : -18, isTempDistance: isTemp }
      );
      updateZoomInvariantElements();
      return;
    }

    // Primary Width Laser Beam (pA <-> pB, crimson-pink) + endpoint pins
    addLaserBeam(info.pA, info.pB, 0xff2d55, 1.85, 0.95);
    add3DPinMarker(info.pA, 0xff2d55, studioThree.overlayGroup, addObj);
    add3DPinMarker(info.pB, 0xff2d55, studioThree.overlayGroup, addObj);

    // Secondary Orthogonal Length Laser Beam (orthoPA <-> orthoPB, vivid sky-blue) + 90° intersection tick
    if (info.orthoPA && info.orthoPB && info.orthoLength) {
      addLaserBeam(info.orthoPA, info.orthoPB, 0x38bdf8, 1.40, 0.88);
      add3DPinMarker(info.orthoPA, 0x38bdf8, studioThree.overlayGroup, addObj);
      add3DPinMarker(info.orthoPB, 0x38bdf8, studioThree.overlayGroup, addObj);

      // Draw crisp 90° right-angle symbol at intersection of Width & Length axes
      const crossC = info.crossPt || new THREE.Vector3().addVectors(info.pA, info.pB).multiplyScalar(0.5);
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

    const mid = new THREE.Vector3().addVectors(info.pA, info.pB).multiplyScalar(0.5);
    const labelAnchor = mid.clone().lerp(info.originPt, 0.55);

    let titlePrefix = "路寬";
    const subParts = [];
    if (info.kind === "room") {
      titlePrefix = "室內 寬";
      if (info.areaM2) subParts.push(`面積 ${info.areaM2.toFixed(1)} m²`);
      if (info.ceilHeight) subParts.push(`淨高 ${info.ceilHeight.toFixed(2)} m`);
    } else if (info.kind === "pool") {
      titlePrefix = "寬";
      if (info.areaM2) subParts.push(`面積 ${info.areaM2.toFixed(1)} m²`);
      if (info.pitDepth) subParts.push(`深 ${info.pitDepth.toFixed(2)} m`);
    } else if (info.kind === "corridor" || info.kind === "wall_span") {
      titlePrefix = "淨寬";
      if (info.ceilHeight) subParts.push(`淨高 ${info.ceilHeight.toFixed(2)} m`);
    } else {
      titlePrefix = "路寬";
      if (Number.isFinite(info.crossSlopePct)) {
        subParts.push(`橫坡 ${info.crossSlopePct.toFixed(1)}%`);
      }
      if (info.ceilHeight) {
        subParts.push(`淨高 ${info.ceilHeight.toFixed(2)} m`);
      }
    }

    const lenChipHtml = info.orthoLength
      ? `<span class="autodesk-laser-len-chip">× 長 ${info.orthoLength.toFixed(2)} m</span>`
      : "";
    const subHtml = subParts.length > 0 ? `<span class="autodesk-sub-pill">${subParts.join(" · ")}</span>` : "";

    add2DBadge(
      labelAnchor,
      `<div class="autodesk-flex-badge autodesk-laser-badge ${isTemp ? "" : "pinned"}"><span>🔴 ${titlePrefix} ${info.width.toFixed(2)} m</span>${lenChipHtml}${subHtml}</div>`,
      "#e11d48",
      { rawHtml: true, offsetY: isTemp ? -26 : -16, isTempDistance: isTemp }
    );

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
    const btn = document.getElementById("btnDockGenerateScan");
    if (badge) {
      badge.textContent = String(cnt);
      badge.style.display = cnt > 0 ? "inline-block" : "none";
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

  function handleStudioCanvasClick(e) {
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
          showToast("🔴 牆面起點已標記，請點擊牆面終點 (Point 1/2 placed — click wall end point)");
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
      add3DPinMarker(pt, 0x0284c7);
      openRtkPhotoInspector(pt, true);
      return;
    }

    if (tool === "comments") {
      add3DPinMarker(pt, 0x0284c7);
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
        if (studioThree && studioThree.polyPreviewGroup) {
          while (studioThree.polyPreviewGroup.children.length > 0) {
            studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
          }
        }
        const lockedPts = STATE.measurePoints.map((p) => p.clone());
        STATE.measurePoints = [];
        showToast(`Area polygon closed (${lockedPts.length} vertices)`);
        syncStudioMobileToolHud();
        return;
      }

      STATE.measurePoints.push(pt.clone());
      const pts = STATE.measurePoints.slice();
      clearAreaVisualsOnly();
      const addAreaObj = (m) => {
        m.userData.isAreaVisual = true;
        studioThree.overlayGroup.add(m);
      };
      pts.forEach((p, idx) => {
        add3DPinMarker(p, idx === 0 ? 0xff3b30 : 0x0284c7, studioThree.overlayGroup, addAreaObj);
      });
      if (pts.length >= 2) {
        const loopPts = pts.length >= 3 ? [...pts, pts[0]] : pts;
        const lineGeom = new THREE.BufferGeometry().setFromPoints(loopPts);
        const lineMesh = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: 0x0284c7, depthTest: false }));
        addAreaObj(lineMesh);
      }
      if (pts.length >= 3) {
        STATE.maskBoundaryPoints = pts.map((p) => p.clone());
        let area2 = 0;
        let perim = 0;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          area2 += a.x * b.z - b.x * a.z;
          perim += a.distanceTo(b);
        }
        const areaM2 = Math.abs(area2) * 0.5;
        const areaPing = areaM2 * 0.3025;
        const centroid = pts.reduce((acc, p) => acc.add(p.clone()), new THREE.Vector3()).divideScalar(pts.length);
        add2DBadge(
          centroid,
          `Area: <b>${areaM2.toFixed(2)} m²</b> (${areaPing.toFixed(2)} 坪) · Perim: ${perim.toFixed(2)}m`,
          "#cbd5e1",
          { isArea: true }
        );
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

    if (tool === "contours") {
      if (STATE.measurePoints.length >= 3 && isNearStartVertex(pt, STATE.measurePoints[0])) {
        if (studioThree && studioThree.polyPreviewGroup) {
          while (studioThree.polyPreviewGroup.children.length > 0) {
            studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
          }
        }
        STATE.maskBoundaryPoints = STATE.measurePoints.map((p) => p.clone());
        showToast(`Mask boundary locked (${STATE.maskBoundaryPoints.length} vertices) — updating Civil3D.dwg & A3 PDF`);
        STATE.measurePoints = [];
        openContoursInspector();
        syncStudioMobileToolHud();
        return;
      }

      STATE.measurePoints.push(pt.clone());
      const pts = STATE.measurePoints.slice();
      add3DPinMarker(pt, pts.length === 1 ? 0xff3b30 : 0x0284c7);

      if (pts.length >= 3) {
        STATE.maskBoundaryPoints = pts.map((p) => p.clone());
        openContoursInspector();
      } else {
        showToast(`Mask Boundary Point ${pts.length} placed — click ${3 - pts.length} more point${3 - pts.length === 1 ? "" : "s"} to clip contours`);
      }
      syncStudioMobileToolHud();
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

  function sampleStudioMeshElevationAtLocalXZ(lx, lz, fallbackY = 0, cachedTargets = null) {
    const targets = cachedTargets || getStudioRaycastMeshes();
    if (!targets.length) return { y: fallbackY, hit: false };
    const rayTopY = Math.max(450, (Number(studioThree?.boundingSphere?.radius) || 60) * 3 + 200);
    _downRayOrigin.set(lx, rayTopY, lz);
    _downRaycaster.set(_downRayOrigin, _downRayDir);
    const hits = _downRaycaster.intersectObjects(targets, true);
    if (hits && hits.length > 0) {
      return { y: hits[0].point.y, hit: true };
    }
    return { y: fallbackY, hit: false };
  }

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
    const targets = getStudioRaycastMeshes();

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
        const sHit = sampleStudioMeshElevationAtLocalXZ(sx, sz, linY, targets);
        perimSamples.push({ x: sx, y: sHit.hit ? sHit.y : linY, z: sz });
      }
    }

    const perimMeanLocalY =
      perimSamples.reduce((acc, p) => acc + p.y, 0) / Math.max(1, perimSamples.length);
    const perimMeanH = ch + perimMeanLocalY;
    const baseMode = opts.base_mode || "triangulated_boundary";
    const datumH = Number.isFinite(opts.datum_elevation_m) ? opts.datum_elevation_m : perimMeanH;
    const datumLocalY = datumH - ch;

    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minZ = Math.min(...pts.map((p) => p.z));
    const maxZ = Math.max(...pts.map((p) => p.z));
    const spanX = Math.max(0.2, maxX - minX);
    const spanZ = Math.max(0.2, maxZ - minZ);

    const nx = 26;
    const nz = 26;
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

        // Interpolate perimeter elevation at (gx, gz)
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
        const sSurf = sampleStudioMeshElevationAtLocalXZ(gx, gz, yPerimBase, targets);
        if (sSurf.hit) hitCells++;
        const ySurf = sSurf.y;

        let yBase = yPerimBase;
        if (baseMode === "custom_plane") {
          yBase = datumLocalY;
        } else if (baseMode === "epoch_diff") {
          yBase = yPerimBase - 0.18;
        }

        const deltaY = ySurf - yBase;
        maxDz = Math.max(maxDz, deltaY);
        minDz = Math.min(minDz, deltaY);

        if (deltaY >= 0) fillVol += deltaY * cellArea;
        else cutVol += Math.abs(deltaY) * cellArea;

        surfaceArea += cellArea * 1.04;
        if (heatmapCells.length < 260) {
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

    // Generate client-side downloadable CSV & HTML Blob URLs so Report/CSV work even offline
    const csvLines = [
      "GatheringScans Civil Engineering & Stockpile Volume Report",
      `Project Group,"${activeScan.project_group || ""}"`,
      `Scan Name,"${activeScan.name || ""}"`,
      `Zone / Stockpile Name,"${opts.stockpile_name || "Stockpile A"}"`,
      `Base Surface Mode,${baseMode}`,
      "",
      "Metric,Value,Unit",
      `Fill / Stockpile Volume (+),${fillVol.toFixed(2)},m3`,
      `Cut / Excavation Volume (-),${cutVol.toFixed(2)},m3`,
      `Net Earthwork Volume,${netVol.toFixed(2)},m3`,
      `2D Planar Footprint Area,${planarAreaM2.toFixed(2)},m2`,
      `2D Planar Footprint Area (Ping),${planarAreaPing.toFixed(2)},ping`,
      `3D Sloped Surface Area,${Math.max(surfaceArea, planarAreaM2).toFixed(2)},m2`,
      `Boundary Perimeter,${perim.toFixed(2)},m`,
      `Material Classification,"${matObj.name}",`,
      `Material Bulk Density,${density.toFixed(2)},t/m3`,
      `Estimated Material Mass (Loose),${tonnageLoose.toFixed(2)},t`,
      `Estimated Bank Mass,${tonnageBank.toFixed(2)},t`,
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

    const htmlDoc = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><title>Stockpile Volume Report — ${escapeHtml(
      opts.stockpile_name || "Stockpile A"
    )}</title><style>body{font-family:sans-serif;max-width:880px;margin:28px auto;color:#0f172a}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left}th{background:#f1f5f9}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.card{border:1px solid #cbd5e1;border-radius:8px;padding:12px;background:#f8fafc}.val{font-size:20px;font-weight:800;margin-top:4px}</style></head><body><h2>土方體積與物料堆置量測報告 (Stockpile &amp; Cut/Fill Report)</h2><div>Project: <b>${escapeHtml(
      activeScan.project_group || ""
    )}</b> | Scan: <b>${escapeHtml(activeScan.name || "")}</b> | Zone: <b>${escapeHtml(
      opts.stockpile_name || "Stockpile A"
    )}</b></div><div class="grid"><div class="card"><div>Fill Volume (+)</div><div class="val" style="color:#0284c7">+${fillVol.toFixed(
      2
    )} m³</div></div><div class="card"><div>Cut Volume (-)</div><div class="val" style="color:#dc2626">-${cutVol.toFixed(
      2
    )} m³</div></div><div class="card"><div>Net Volume</div><div class="val">${
      netVol >= 0 ? "+" : ""
    }${netVol.toFixed(2)} m³</div></div><div class="card"><div>Estimated Mass</div><div class="val">${tonnageLoose.toFixed(
      2
    )} t</div></div></div><table><tr><th>Footprint Area</th><td>${planarAreaM2.toFixed(
      2
    )} m² (${planarAreaPing.toFixed(2)} 坪)</td><th>Perimeter</th><td>${perim.toFixed(
      2
    )} m</td></tr><tr><th>Material</th><td>${escapeHtml(
      matObj.name
    )} (${density.toFixed(2)} t/m³)</td><th>Datum Z₀</th><td>+${datumH.toFixed(
      3
    )} m</td></tr></table><table><thead><tr><th>Vertex</th><th>TWD97 E (m)</th><th>TWD97 N (m)</th><th>TWVD2001 H (m)</th></tr></thead><tbody>${boundaryTwd97
      .map(
        (v) =>
          `<tr><td>V${v.vertex}</td><td>${v.easting_m.toFixed(3)}</td><td>${v.northing_m.toFixed(
            3
          )}</td><td>+${v.twvd2001_h_m.toFixed(3)}</td></tr>`
      )
      .join("")}</tbody></table></body></html>`;
    const htmlBlob = new Blob([htmlDoc], { type: "text/html;charset=utf-8" });
    const htmlUrl = URL.createObjectURL(htmlBlob);
    STATE._lastVolHtmlBlobUrl = htmlUrl;

    return {
      status: "ok",
      scan_id: activeScan.scan_id,
      scan_name: activeScan.name,
      project_group: activeScan.project_group,
      stockpile_name: opts.stockpile_name || "Stockpile A",
      crs_short: "TWD97 (121) + TWVD2001",
      base_mode: baseMode,
      datum_elevation_m: Number(datumH.toFixed(3)),
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
      heatmap_cells: heatmapCells,
      hit_ratio: insideCells > 0 ? hitCells / insideCells : 0,
      report_html_url: htmlUrl,
      report_csv_url: csvUrl,
      _resolvedPtsLocal: pts,
    };
  }

  // Helper to push a 3D volumetric box prism (top face + 4 vertical side faces) into a triangle buffer
  function pushBoxPrismTriangles(arr, x, z, hs, yLow, yHigh) {
    const x0 = x - hs, x1 = x + hs;
    const z0 = z - hs, z1 = z + hs;
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

  // Draw the user's placed Cut/Fill vertices, boundary lines, and real DSM 3D cut/fill columns in studioThree.volumeGroup
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

    // 2. Boundary Outline
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
    const minY =
      volumeRes && Number.isFinite(volumeRes.datum_elevation_m)
        ? Number(volumeRes.datum_elevation_m) - ch
        : Math.min(...pts.map((p) => p.y)) - 0.1;
    const maxY = Math.max(...pts.map((p) => p.y));
    const centroid = pts.reduce((acc, p) => acc.add(p.clone()), new THREE.Vector3()).divideScalar(pts.length);

    // 3. Render real 3D Cut/Fill volumetric prisms when heatmap_cells are returned
    const cells = volumeRes && Array.isArray(volumeRes.heatmap_cells) ? volumeRes.heatmap_cells : [];
    if (cells.length > 0) {
      const fillPositions = [];
      const cutPositions = [];
      const cellStep = Number(volumeRes?.cell_step_m) || 0.45;
      const halfStep = Math.max(0.03, Math.min(0.32, cellStep * 0.42));
      cells.forEach((c) => {
        const x = Number(c.lx || 0);
        const z = Number(c.lz || 0);
        const ySurf = Number(c.ly_surf || 0) + 0.015;
        const yBase = Number(c.ly_base || 0);
        const dz = Number(c.dz || 0);
        if (Math.abs(dz) < 0.006) return;
        const yLow = Math.min(yBase, ySurf);
        const yHigh = Math.max(yBase, ySurf);
        if (dz >= 0) {
          pushBoxPrismTriangles(fillPositions, x, z, halfStep, yLow, yHigh);
        } else {
          pushBoxPrismTriangles(cutPositions, x, z, halfStep, yLow, yHigh);
        }
      });
      if (fillPositions.length > 0) {
        const fillGeo = new THREE.BufferGeometry();
        fillGeo.setAttribute("position", new THREE.Float32BufferAttribute(fillPositions, 3));
        const fillMesh = new THREE.Mesh(
          fillGeo,
          new THREE.MeshBasicMaterial({
            color: 0x0ea5e9,
            transparent: true,
            opacity: 0.44,
            side: THREE.DoubleSide,
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
            opacity: 0.44,
            side: THREE.DoubleSide,
            depthWrite: false,
          })
        );
        cutMesh.renderOrder = 995;
        studioThree.volumeGroup.add(cutMesh);
      }
    } else {
      // Initial boundary triangulation while awaiting calculation
      const positions = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        positions.push(a.x, a.y + 0.03, a.z, b.x, b.y + 0.03, b.z, centroid.x, centroid.y + 0.03, centroid.z);
        positions.push(a.x, minY, a.z, b.x, minY, b.z, b.x, b.y + 0.03, b.z);
        positions.push(a.x, minY, a.z, b.x, b.y + 0.03, b.z, a.x, a.y + 0.03, a.z);
      }
      const prismGeo = new THREE.BufferGeometry();
      prismGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      const prismMesh = new THREE.Mesh(
        prismGeo,
        new THREE.MeshBasicMaterial({
          color: 0x0ea5e9,
          transparent: true,
          opacity: 0.34,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      prismMesh.renderOrder = 995;
      studioThree.volumeGroup.add(prismMesh);
    }

    // Base datum outline & vertical drop lines at vertices
    const baseLoopPts = [...pts.map((p) => new THREE.Vector3(p.x, minY, p.z)), new THREE.Vector3(pts[0].x, minY, pts[0].z)];
    const baseLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(baseLoopPts),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, depthTest: false, transparent: true, opacity: 0.78 })
    );
    baseLine.renderOrder = 996;
    studioThree.volumeGroup.add(baseLine);

    // 4. 2D Cut/Fill Volume & Tonnage Badge at Polygon Centroid
    const badgePos = new THREE.Vector3(centroid.x, maxY + 0.45, centroid.z);
    if (volumeRes) {
      add2DBadge(
        badgePos,
        `Fill: <b style="color:#0284c7;">+${volumeRes.fill_volume_m3} m³</b> · Cut: <b style="color:#ef4444;">-${volumeRes.cut_volume_m3} m³</b> · Net: <b>${volumeRes.net_volume_m3 >= 0 ? "+" : ""}${volumeRes.net_volume_m3} m³</b> (${volumeRes.estimated_tonnage_t} t)`,
        "#0284c7",
        { isVolume: true }
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
    titleEl.innerHTML = title;
    bodyEl.innerHTML = htmlContent;
    panel.setAttribute("data-active-tool", STATE.activeTool || "");
    panel.classList.remove("hidden");
    panel.classList.add("active", "open");
    panel.classList.toggle("mobile-minimized", Boolean(STATE.sidePanelMinimized));
    panel.classList.toggle("gs-panel-minimized", Boolean(STATE.sidePanelMinimized));
    const lblCollapse = document.getElementById("lblCollapseSidePanel");
    if (lblCollapse) {
      lblCollapse.textContent = STATE.sidePanelMinimized ? "▴ 展開" : "▾ 收合";
    }
    if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
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
      lblCollapse.textContent = STATE.sidePanelMinimized ? "▴ 展開" : "▾ 收合";
    }
    update2DBadgePositions();
  });

  document.getElementById("btnCloseSidePanel")?.addEventListener("click", () => {
    clearSectionBoxClippingIfNotKept();
    if (STATE.activeTool === "crop_delete" || STATE.activeTool === "crop" || STATE.activeTool === "optimizer") {
      cancelLassoToolMode(false);
    } else if (
      ["section", "crs", "generate_scan", "rtk", "photos", "comments"].includes(STATE.activeTool)
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
        STATE.maskBoundaryPoints = lockedPts.map((p) => p.clone());
        showToast(`Area polygon locked (${lockedPts.length} vertices)`);
      } else if (STATE.activeTool === "contours") {
        STATE.maskBoundaryPoints = lockedPts.map((p) => p.clone());
        showToast(`Mask boundary locked (${lockedPts.length} vertices) — updating Civil3D.dwg & A3 PDF`);
        openContoursInspector();
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
          ${isOrbitSub ? "🔄 旋轉中 (點此套索)" : "✏️ 套索標記 (點此旋轉)"}
        </button>
        ${
          STATE.lassoInputMethod === "polygon" && ptsCount >= 3
            ? `<button type="button" class="gs-mobile-hud-btn primary" data-mobile-hud="lock_poly">✓ 鎖定 (${ptsCount}點)</button>`
            : ""
        }
        ${
          pendingRegions > 0
            ? `<button type="button" class="gs-mobile-hud-btn primary" data-mobile-hud="commit_lasso">✓ ${
                isDel ? "執行刪除" : "執行保留"
              } (${pendingRegions})</button>`
            : ""
        }
        ${
          hasAnyMarks
            ? `<button type="button" class="gs-mobile-hud-btn" data-mobile-hud="undo_lasso">↩ 復原</button>`
            : ""
        }
        <button type="button" class="gs-mobile-hud-btn" data-mobile-hud="expand_cat_panel">${
          STATE.sidePanelMinimized ? "▴ 面板" : "▾ 收合"
        }</button>
        <button type="button" class="gs-mobile-hud-btn danger" data-mobile-hud="exit_tool">✕ 離開</button>
      `;
    } else if (tool === "area" || tool === "volume" || tool === "contours") {
      if (ptsCount === 0) {
        hud.style.display = "none";
        return;
      }
      const toolLabel = tool === "area" ? "面積" : tool === "volume" ? "土方" : "等高線邊界";
      hud.style.display = "flex";
      hud.innerHTML = `
        <span class="gs-mobile-hud-label">📐 ${toolLabel}：已標記 ${ptsCount} 點</span>
        ${
          ptsCount >= 3
            ? `<button type="button" class="gs-mobile-hud-btn primary" data-mobile-hud="lock_poly">✓ 完成多邊形 (Lock)</button>`
            : `<span class="gs-mobile-hud-label" style="color:var(--ui-text-secondary);">再點 ${3 - ptsCount} 點可閉合</span>`
        }
        <button type="button" class="gs-mobile-hud-btn" data-mobile-hud="undo_pt">↩ 復原點</button>
        <button type="button" class="gs-mobile-hud-btn danger" data-mobile-hud="clear_pts">✕ 清除</button>
      `;
    } else if (tool === "distance" || tool === "angle" || tool === "profile") {
      if (ptsCount === 0) {
        hud.style.display = "none";
        return;
      }
      const toolLabel = tool === "distance" ? "距離" : tool === "angle" ? "角度" : "剖面";
      hud.style.display = "flex";
      hud.innerHTML = `
        <span class="gs-mobile-hud-label">📏 ${toolLabel}：已標記 ${ptsCount} 點</span>
        <button type="button" class="gs-mobile-hud-btn" data-mobile-hud="undo_pt">↩ 復原點</button>
        <button type="button" class="gs-mobile-hud-btn danger" data-mobile-hud="clear_pts">✕ 取消</button>
      `;
    } else if (tool === "categorize" && STATE.categorizeEditMode) {
      const mode = STATE.categorizeEditMode;
      const catPts = Array.isArray(STATE.categorizeEditPoints) ? STATE.categorizeEditPoints.length : 0;
      const modeText =
        mode === "add_tree"
          ? "🟢 點擊 3D 樹木新增"
          : mode === "add_wall"
          ? `🔴 點擊牆面起終點 (${catPts}/2)`
          : mode === "add_road"
          ? `🟠 點擊道路頂點 (${catPts}點)`
          : "🗑️ 點擊 3D 物件刪除";
      hud.style.display = "flex";
      hud.innerHTML = `
        <span class="gs-mobile-hud-label">${modeText}</span>
        ${
          (mode === "add_road" && catPts >= 3) || (mode === "add_wall" && catPts >= 2)
            ? `<button type="button" class="gs-mobile-hud-btn primary" data-mobile-hud="lock_poly">✓ 完成新增</button>`
            : ""
        }
        ${
          catPts > 0
            ? `<button type="button" class="gs-mobile-hud-btn" data-mobile-hud="undo_cat_pt">↩ 復原點</button>`
            : ""
        }
        <button type="button" class="gs-mobile-hud-btn" data-mobile-hud="expand_cat_panel">${
          STATE.sidePanelMinimized ? "▴ 面板" : "▾ 收合"
        }</button>
        <button type="button" class="gs-mobile-hud-btn danger" data-mobile-hud="exit_cat_edit">✕ 結束編輯</button>
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
          ? "🔄 已切換為單指旋轉視角 (1-Finger Orbit Mode)"
          : "✏️ 已切換為單指套索標記 (1-Finger Lasso Draw Mode)"
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
            ? `已套用保留範圍 (${res.committed} 區) — 點擊 Generate 建立新掃描`
            : `已刪除選取範圍 (${res.committed} 區) — 點擊 Generate 建立新掃描`
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
            const loopPts = pts.length >= 3 ? [...pts, pts[0]] : pts;
            const lineGeom = new THREE.BufferGeometry().setFromPoints(loopPts);
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
      if (lblCol) lblCol.textContent = STATE.sidePanelMinimized ? "▴ 展開" : "▾ 收合";
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
      const matOptions = Object.entries(STATE.materials || {
        crushed_stone: { name: "Crushed Stone / 碎石級配", density_t_m3: 1.65 },
        excavated_soil: { name: "Excavated Soil / 一般營建土方", density_t_m3: 1.45 },
        sand_gravel: { name: "River Sand & Gravel / 砂石骨材", density_t_m3: 1.75 },
        rockfill_rip_rap: { name: "Quarry Rockfill / 塊石與拋石", density_t_m3: 1.85 },
        concrete_debris: { name: "Demolition Concrete / 營建剩餘混凝土", density_t_m3: 1.55 },
      })
        .map(
          ([k, v]) =>
            `<option value="${escapeHtml(k)}" data-density="${escapeHtml(String(v.density_t_m3))}">${escapeHtml(v.name)} (${escapeHtml(String(v.density_t_m3))} t/m³)</option>`
        )
        .join("");

      showSidePanel(
        `<span>Cut/Fill &amp; Stockpile Volume</span>`,
        `
        ${stagedNoticeHtml}
        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:7px 9px;margin-bottom:9px;line-height:1.4;">
          Step 1: Click <b>3+ points</b> on the 3D scan to draw a Cut/Fill boundary polygon.<br>
          Step 2: Click red start point <b>V1</b> (or press <b>Enter</b> / <b>Lock &amp; Compute</b>) to lock the polygon and calculate volume.
        </div>
        <div class="gs-form-group">
          <label>Zone / Stockpile Name (土方或物料堆名稱)</label>
          <input type="text" class="gs-input" id="volStockpileName" value="${escapeHtml(defaultZoneName)}" />
        </div>
        <div class="gs-form-group">
          <label>Base Reference Surface Mode (基準面計算方式)</label>
          <select class="gs-select" id="volBaseMode">
            <option value="triangulated_boundary">1. Triangulated Boundary Perimeter (獨立土石堆周界擬合面)</option>
            <option value="custom_plane">2. Custom Datum Elevation Plane Z₀ (指定設計高程基準面 TWVD2001)</option>
            <option value="epoch_diff">3. Multi-Date Epoch-to-Epoch Diff (跨期掃描進度挖填差額)</option>
          </select>
        </div>
        <div class="gs-form-group">
          <label>Material Classification &amp; Bulk Density (物料種類與比重 t/m³)</label>
          <select class="gs-select" id="volMaterialSelect">${matOptions}</select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;" class="gs-form-group">
          <div>
            <label>Density (t/m³)</label>
            <input type="number" step="0.05" class="gs-input" id="volCustomDensity" value="1.65" />
          </div>
          <div>
            <label>Datum Elev Z₀ (TWVD2001 m)</label>
            <input type="number" step="0.1" class="gs-input" id="volDatumZ" value="${defaultDatumZ}" />
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:8px;">
          <button type="button" class="gs-top-btn accent" style="flex:1.6;justify-content:center;" id="btnRunVolumeCalc" title="Lock Polygon &amp; Compute Cut/Fill Volume">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M3 18L9 8l5 6 4-4 3 8H3z"/>
            </svg>
            <span id="lblRunVolumeCalc">Lock &amp; Compute</span>
          </button>
          <button type="button" class="gs-top-btn" style="flex:1;justify-content:center;" id="btnResetVolumePoly" title="Clear &amp; Draw New Boundary Polygon">
            <span>Redraw Polygon</span>
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
        btnLbl.textContent = placedCount >= 3 ? `Lock (${placedCount} pts) & Compute` : "Lock & Compute";
      }
      if (placedCount === 0) {
        box.innerHTML = `
          <div style="font-size:11.5px;color:var(--ui-text-secondary);padding:10px;background:var(--ui-bg-subtle);border-radius:8px;border:1px dashed var(--ui-border-strong);line-height:1.5;">
            <b style="color:var(--ui-accent);">Awaiting Boundary Polygon (尚未繪製範圍)</b><br>
            Click at least <b>3 points</b> around a stockpile or excavation zone on the 3D scan, then click the red start point <b>V1</b> (or press <b>Enter</b>) to lock the polygon and calculate volume.
          </div>
        `;
      } else if (placedCount < 3) {
        box.innerHTML = `
          <div style="font-size:11.5px;color:var(--ui-text-primary);padding:10px;background:var(--ui-bg-subtle);border-radius:8px;border:1px solid var(--ui-accent);line-height:1.5;">
            <b>Drawing Polygon: ${placedCount} / 3+ vertices placed</b><br>
            Click <b>${3 - placedCount} more point${3 - placedCount === 1 ? "" : "s"}</b> on the 3D scan to form a valid boundary.
          </div>
        `;
      } else {
        box.innerHTML = `
          <div style="font-size:11.5px;color:var(--ui-text-primary);padding:10px;background:var(--ui-accent-soft);border-radius:8px;border:1px solid var(--ui-accent);line-height:1.5;">
            <b style="color:var(--ui-accent);">Ready to Lock: ${placedCount} vertices placed</b><br>
            Click the red start point <b>V1</b> on the 3D scan, press <b>Enter</b>, or click <b>Lock (${placedCount} pts) &amp; Compute</b> above to calculate earthwork volume.
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
            <div class="lbl">Fill Volume (+)</div>
            <div class="val" style="color:var(--ui-accent);">+${escapeHtml(String(res.fill_volume_m3))} m³</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">Cut Volume (-)</div>
            <div class="val" style="color:#ef4444;">-${escapeHtml(String(res.cut_volume_m3))} m³</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">Net Volume</div>
            <div class="val">${Number(res.net_volume_m3) >= 0 ? "+" : ""}${escapeHtml(String(res.net_volume_m3))} m³</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">Estimated Mass</div>
            <div class="val">${escapeHtml(String(res.estimated_tonnage_t))} t</div>
          </div>
        </div>
        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-subtle);padding:9px 10px;border-radius:8px;border:1px solid var(--ui-border);margin-bottom:10px;line-height:1.5;">
          <div><b>Footprint Area:</b> ${escapeHtml(String(res.planar_area_m2))} m² (${escapeHtml(String(res.planar_area_ping))} 坪) · <b>Vertices:</b> ${(res.boundary_twd97 || []).length}</div>
          <div><b>Sloped Area:</b> ${escapeHtml(String(res.surface_area_m2))} m² · <b>Perim:</b> ${escapeHtml(String(res.perimeter_m))} m</div>
          <div><b>Base Surface:</b> ${
            res.base_mode === "custom_plane"
              ? `Custom Datum Z₀ (+${escapeHtml(String(res.datum_elevation_m))} m)`
              : res.base_mode === "epoch_diff"
              ? "Multi-Date Epoch Diff"
              : `Perimeter Fit (Mean +${escapeHtml(String(res.perim_mean_h_m ?? res.datum_elevation_m))} m)`
          }</div>
          <div><b>Material:</b> ${escapeHtml(String(res.material_name || ""))} (${escapeHtml(String(res.density_t_m3))} t/m³ · Bank: ${escapeHtml(String(res.bank_tonnage_t ?? res.estimated_tonnage_t))} t)</div>
        </div>
        <div style="display:flex;gap:6px;">
          <a class="btn-xs primary" style="flex:1;justify-content:center;" href="${safeHtmlUrl}" target="_blank" rel="noopener noreferrer" title="Open Printable Stockpile Report (PDF/HTML)">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            <span>Report</span>
          </a>
          <a class="btn-xs" style="flex:1;justify-content:center;" href="${safeCsvUrl}" download="stockpile_volume_report.csv" title="Export Excel (.CSV)">
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
  async function openContoursInspector() {
    setActiveStudioTool("contours");
    if (!STATE.measurePoints || STATE.measurePoints.length === 0) {
      STATE.sidePanelMinimized = false;
    }
    const activeScan = STATE.activeScan || STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || {};
    const defaultTitle = `${activeScan.name || STATE.activeScanId} — Topographic Survey`;
    const maskPts =
      STATE.maskBoundaryPoints && STATE.maskBoundaryPoints.length >= 3
        ? STATE.maskBoundaryPoints
        : STATE.measurePoints && STATE.measurePoints.length >= 3
        ? STATE.measurePoints
        : [];

    const panel = document.getElementById("studioSidePanel");
    const alreadyOpenForContours = panel?.classList.contains("active") && document.getElementById("cntDrawingTitle");

    if (!alreadyOpenForContours) {
      const stagedContoursNotice = hasStagedMeshEditsForActiveScan()
        ? `<div style="font-size:11px;color:#fbbf24;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);border-radius:7px;padding:7px 9px;margin-bottom:9px;line-height:1.4;">
             ⚠️ <b>Staged Mesh Edits Active:</b> Server-side <code>.DXF</code> &amp; A3 PDF contours read committed scan geometry on disk. Run <b>Generate Edited Scan</b> first if you want staged deletions baked into the survey report.
           </div>`
        : "";
      showSidePanel(
        `<span>Survey Report (Civil3D.dwg &amp; A3 PDF)</span>`,
        `
        ${stagedContoursNotice}
        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:7px 9px;margin-bottom:9px;line-height:1.45;">
          Uses your active <b>Mask Boundary</b> &amp; <b>Contour Lines</b> to generate <code>Civil3D.dwg</code> (real <b>${escapeHtml(getScanCrsDisplayLabel(activeScan))}</b>) and a zoom-to-fit <b>A3 Ready-to-Print PDF</b> with filled engineering frame. Click 3+ points on the scan to customize the mask boundary.
        </div>
        <div class="gs-form-group">
          <label>Engineering Frame Title (圖名 / 掃描專案名稱)</label>
          <input type="text" class="gs-input" id="cntDrawingTitle" value="${escapeHtml(defaultTitle)}" />
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;" class="gs-form-group">
          <div>
            <label>Minor Interval (次等高線 m)</label>
            <select class="gs-select" id="cntMinorStep">
              <option value="0.25">0.25 m</option>
              <option value="0.5" selected>0.50 m</option>
              <option value="1.0">1.00 m</option>
              <option value="2.0">2.00 m</option>
            </select>
          </div>
          <div>
            <label>Major Interval (計曲線 m)</label>
            <select class="gs-select" id="cntMajorStep">
              <option value="1.0">1.00 m</option>
              <option value="2.5" selected>2.50 m</option>
              <option value="5.0">5.00 m</option>
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;" class="gs-form-group">
          <div>
            <label>Surveyor (測量工程師)</label>
            <input type="text" class="gs-input" id="cntEngineerName" value="${escapeHtml(STATE.currentUser?.name || "雲在天")}" />
          </div>
          <div>
            <label>Mask Boundary (邊界遮罩)</label>
            <div style="display:flex;gap:4px;">
              <button type="button" class="btn-xs" style="flex:1;justify-content:center;" id="btnDrawCustomMask" title="Click 3+ points on 3D scan to define custom mask boundary">Draw</button>
              <button type="button" class="btn-xs" style="flex:1;justify-content:center;" id="btnResetCustomMask" title="Reset to default scan footprint boundary">Reset</button>
            </div>
          </div>
        </div>
        <div class="gs-form-group" style="margin-bottom:8px;">
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;font-weight:600;color:var(--ui-text-primary);">
            <input type="checkbox" id="chkBareEarthContours" checked />
            <span>濾除樹木與建物之純地形等高線 (Bare-Earth DTM Contours)</span>
          </label>
        </div>
        <button type="button" class="gs-top-btn accent" style="width:100%;justify-content:center;margin-bottom:8px;" id="btnGenerateContours" title="Generate .DXF (AutoCAD / Civil 3D) &amp; A3 Ready-to-Print PDF Survey Report">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
          <span>Create Survey Report (.DXF + A3 PDF)</span>
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
          if (lblCol) lblCol.textContent = "▴ 展開";
        }
        syncStudioMobileToolHud();
        showToast("Click 3+ points on the 3D scan to draw a custom Mask Boundary");
      });

      document.getElementById("btnResetCustomMask")?.addEventListener("click", () => {
        STATE.maskBoundaryPoints = [];
        STATE.measurePoints = [];
        runContours();
        showToast("Reset to default scan survey mask boundary");
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
    await runContours();
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
            <span>A3 ENGINEERING SHEET PREVIEW (420×297mm)</span>
            <span style="color:var(--ui-accent);">SCALE 1:${res.scale_denom || 250}</span>
          </div>
          <canvas id="a3SheetPreviewCanvas" width="336" height="210" style="width:100%;background:#ffffff;border:1px solid var(--ui-border-strong);border-radius:7px;box-shadow:0 1px 3px rgba(15,23,42,0.06);"></canvas>
        </div>
        <div class="gs-metric-grid">
          <div class="gs-metric-box">
            <div class="lbl">Clipped Contours</div>
            <div class="val" style="color:var(--ui-accent);">${res.contour_count} lines</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">A3 Fit Scale</div>
            <div class="val">1:${res.scale_denom || 250}</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">Mask Area</div>
            <div class="val">${res.planar_area_m2 || 0} m²</div>
          </div>
          <div class="gs-metric-box">
            <div class="lbl">TWVD2001 Elev</div>
            <div class="val">+${res.elevation_range_m[0]}~+${res.elevation_range_m[1]}m</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <a class="btn-xs primary" style="flex:1.4;justify-content:center;" href="${escapeHtml(appendAuthToDownloadUrl(res.dxf_url || res.civil3d_dxf_url || res.civil3d_dwg_url || res.dwg_url))}" download="Civil3D.dxf" title="Download .DXF (AutoCAD / Civil 3D — Real TWD97 XYZ + A3 Engineering Frame)">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>.DXF (AutoCAD / Civil 3D)</span>
          </a>
          <a class="btn-xs primary" style="flex:1;justify-content:center;" href="${escapeHtml(appendAuthToDownloadUrl(res.pdf_url))}" target="_blank" title="Open Ready-to-Print A3 Survey Report (.PDF)">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            <span>A3 PDF</span>
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

    showToast(`Survey Report ready: .DXF (AutoCAD / Civil 3D) + A3 PDF (${res.contour_count} clipped contours, 1:${res.scale_denom || 250})`);
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
      topLbl.textContent = vis ? "👁️ AI 分類: 顯示" : "👁️‍🗨️ AI 分類: 隱藏";
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
      topLblTxt.textContent = lblsVis ? "🏷️ 標籤: 顯示" : "🏷️ 標籤: 隱藏";
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
        ? "AI Classification Saved on Server (3D Overlays Visible)"
        : "AI Classification Saved on Server (Hidden by Default)";
    }

    const masterChk = document.getElementById("chkCategorizeMasterVis");
    if (masterChk) {
      masterChk.checked = vis;
    }
    const masterBtn = document.getElementById("btnToggleCategorizeOverlayVis");
    if (masterBtn) {
      masterBtn.textContent = vis ? "👁️ 顯示中 (點擊隱藏 3D 圖層)" : "👁️‍🗨️ 預設隱藏 (點擊顯示 3D 圖層)";
      masterBtn.classList.toggle("primary", vis);
    }
    const masterBadge = document.getElementById("lblCategorizeVisBadge");
    if (masterBadge) {
      masterBadge.textContent = vis ? "顯示中 Visible" : "預設隱藏 Hidden by Default";
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
          ? "🏷️ AI 分類 2D 浮動標籤：顯示中 (2D Classification Labels Visible)"
          : "🏷️ AI 分類 2D 浮動標籤：已隱藏 (2D Classification Labels Hidden — 3D 圖層仍保留)"
      );
    }
  }

  async function submitCategorizeManualEdit(action, category, itemId = null, itemData = null) {
    const sid = STATE.activeScanId || STATE.activeScan?.scan_id || STATE.lastCategorizeResult?.scan_id || "";
    if (!sid) {
      showToast("請先選擇掃描檔 (No active scan selected)", "warn");
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
          showToast(`🗑️ 已刪除分類項目 ${itemId || ""} (已儲存於伺服器 · Saved on Server)`);
        } else if (action === "manual_add") {
          showToast(`➕ 已新增分類項目 (${category}) (已儲存於伺服器 · Saved on Server)`);
        } else if (action === "manual_reset") {
          showToast("↺ 已還原所有手動新增/刪除變更 (Reset Manual Classification Edits)");
        }
        return updated;
      }
    } catch (err) {
      showToast(`手動編輯分類失敗: ${err.message || err}`, "error");
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
          ? "AI 地物分類 3D 圖層：顯示中 (3D Classification Overlays Visible)"
          : "AI 地物分類 3D 圖層：已隱藏 (預設隱藏 · Hidden by Default)"
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
            `<span style="color:#22d3ee;font-weight:800;">💧 ${escapeHtml(w.id)}</span> ${isVoid ? "水域空洞" : "水體"} · <b>TWVD2001 +${waterLevelH.toFixed(2)}m</b> (${Number(w.planar_area_m2 || 0).toFixed(0)} m²)`,
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
          type: r.label_zh ? String(r.label_zh).split(" (")[0] : "道路 Road",
          metric1: `${Number(r.planar_area_m2 || 0).toFixed(1)} m²`,
          metric2: `W ${Number(r.mean_width_m || 0).toFixed(1)}m · ${Number(r.mean_slope_pct || 0).toFixed(1)}%`,
          fly: toFlyAttr(r.center_twd97, r.center_local),
          label: `${r.id} (${r.planar_area_m2} m²)`,
        });
      });
    }
    if ((activeTab === "all" || activeTab === "trees") && flt.trees) {
      (res.trees || []).slice(0, activeTab === "trees" ? 50 : 12).forEach((t) => {
        rows.push({
          id: t.id,
          catType: "trees",
          badge: `<span style="color:#10b981;font-weight:800;">${escapeHtml(t.id)}</span>`,
          type: "喬木 Tree",
          metric1: `DBH ${Number(t.dbh_cm || 0).toFixed(1)} cm`,
          metric2: `H ${Number(t.height_m || 0).toFixed(1)}m · Ø${Number(t.crown_diameter_m || 0).toFixed(1)}m`,
          fly: toFlyAttr(t.trunk_twd97, t.trunk_local),
          label: `${t.id} (DBH ${t.dbh_cm}cm)`,
        });
      });
    }
    if ((activeTab === "all" || activeTab === "water") && flt.water) {
      (res.water_bodies || []).forEach((w) => {
        rows.push({
          id: w.id,
          catType: "water_bodies",
          badge: `<span style="color:#06b6d4;font-weight:800;">${escapeHtml(w.id)}</span>`,
          type: w.detection_mode === "unmodelled_void_shoreline" ? "水域空洞 Void" : "水體 Water",
          metric1: `${Number(w.planar_area_m2 || 0).toFixed(1)} m²`,
          metric2: `TWVD +${Number(w.water_level_twvd2001_m || 0).toFixed(2)}m`,
          fly: toFlyAttr(w.center_twd97, w.center_local),
          label: `${w.id} (+${w.water_level_twvd2001_m}m)`,
        });
      });
    }
    if ((activeTab === "all" || activeTab === "walls") && flt.walls) {
      (res.walls || []).forEach((wl) => {
        rows.push({
          id: wl.id,
          catType: "walls",
          badge: `<span style="color:#f43f5e;font-weight:800;">${escapeHtml(wl.id)}</span>`,
          type: "擋土牆 Wall",
          metric1: `3D ${Number(wl.vertical_area_m2 || 0).toFixed(1)} m²`,
          metric2: `L ${Number(wl.length_m || 0).toFixed(1)}m · H ${Number(wl.mean_height_m || wl.height_m || 0).toFixed(1)}m`,
          fly: toFlyAttr(wl.center_twd97, wl.center_local),
          label: `${wl.id} (${wl.vertical_area_m2} m²)`,
        });
      });
    }
    if ((activeTab === "all" || activeTab === "stockpiles") && flt.stockpiles) {
      (res.stockpiles || []).forEach((sp) => {
        rows.push({
          id: sp.id,
          catType: "stockpiles",
          badge: `<span style="color:#d97706;font-weight:800;">${escapeHtml(sp.id)}</span>`,
          type: "土石堆置 Mound",
          metric1: `${Number(sp.planar_area_m2 || 0).toFixed(1)} m²`,
          metric2: `~${Number(sp.estimated_volume_m3 || 0).toFixed(1)} m³`,
          fly: toFlyAttr(sp.center_twd97, sp.center_local),
          label: `${sp.id} (${sp.planar_area_m2} m² · ~${sp.estimated_volume_m3} m³)`,
        });
      });
    }

    const breakdownHtml = (res.categories_breakdown || [])
      .slice(0, 10)
      .map(
        (c) => `
        <div style="display:flex;align-items:center;justify-content:space-between;font-size:10.5px;padding:2px 0;">
          <span style="display:inline-flex;align-items:center;gap:5px;color:var(--ui-text-primary);font-weight:600;">
            <span style="width:8px;height:8px;border-radius:2px;background:${escapeHtml(c.color || "#38bdf8")};display:inline-block;"></span>
            ${escapeHtml(c.name_zh || c.name_en)}
          </span>
          <span style="font-family:monospace;color:var(--ui-text-secondary);">${Number(c.planar_area_m2 || c.surface_area_3d_m2 || 0).toLocaleString()} m² (${Number(c.site_share_pct || 0).toFixed(1)}%)</span>
        </div>`
      )
      .join("");

    const exportBarHtml = `
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px;">
        <a class="btn-xs primary" style="flex:1.25;justify-content:center;font-weight:700;" href="${escapeHtml(appendAuthToDownloadUrl(res.dxf_url))}" download="Civil3D_Categorized.dxf" title="Download AutoCAD Civil 3D Categorized .DXF (C-ROAD-BNDY, C-VEG-TREE, C-HYDR-WATR, C-STRC-WALL)">
          <span>📐 .DXF (Civil 3D)</span>
        </a>
        <a class="btn-xs primary" style="flex:1.1;justify-content:center;font-weight:700;" href="${escapeHtml(appendAuthToDownloadUrl(res.report_html_url))}" target="_blank" title="Open Bilingual Printable Categorization Report (.HTML / Save PDF)">
          <span>📄 Report (.HTML/PDF)</span>
        </a>
        <a class="btn-xs" style="flex:0.95;justify-content:center;font-weight:700;" href="${escapeHtml(appendAuthToDownloadUrl(res.report_csv_url))}" download="Categorization_Schedule.csv" title="Download UTF-8 Excel Schedule (.CSV)">
          <span>📊 Excel (.CSV)</span>
        </a>
      </div>
    `;

    const isVis = Boolean(STATE.categorizeOverlayVisible);
    const lblsVis = STATE.categorizeLabelsVisible !== false;
    const editMode = STATE.categorizeEditMode || null;
    const savedAtStr = String(res.saved_at || res.generated_at || "Persisted on Server");

    let editStatusMsg = "點選上方按鈕後，直接點擊 3D 場景即可新增或刪除分類項目 (Click mode button, then click 3D scene)";
    if (editMode === "add_tree") {
      editStatusMsg = "🟢 新增喬木模式：請點擊 3D 場景中的樹木位置 (Click 3D model to add a Tree)";
    } else if (editMode === "add_wall") {
      const nPts = (STATE.categorizeEditPoints || []).length;
      editStatusMsg = `🔴 新增牆面模式：請依序點擊牆面起點與終點 (${nPts}/2 點 · Click 2 points on 3D wall)`;
    } else if (editMode === "add_road") {
      const nPts = (STATE.categorizeEditPoints || []).length;
      editStatusMsg = `🟠 新增道路模式：點擊多邊形頂點 (${nPts} 點)，點擊起點 V1 或按 Enter 完成 (Click V1 or Enter to finish)`;
    } else if (editMode === "remove_click") {
      editStatusMsg = "🗑️ 點選刪除模式：點擊 3D 場景中的樹木/牆面/道路，或點擊下方表格 🗑️ 即可刪除";
    }

    box.innerHTML = `
      ${exportBarHtml}

      <div style="background:rgba(14,165,233,0.10);border:1px solid rgba(56,189,248,0.35);border-radius:8px;padding:7px 9px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;margin-bottom:5px;">
          <span style="font-size:10.5px;font-weight:800;color:#38bdf8;">💾 已儲存於伺服器 (Saved on Server)</span>
          <span id="lblCategorizeVisBadge" style="font-size:9.5px;padding:1px 7px;border-radius:99px;background:${isVis ? "rgba(16,185,129,0.20)" : "rgba(148,163,184,0.18)"};color:${isVis ? "#34d399" : "#94a3b8"};font-weight:700;">
            ${isVis ? "顯示中 Visible" : "預設隱藏 Hidden by Default"}
          </span>
        </div>
        <div style="font-size:9.5px;color:var(--ui-text-muted);margin-bottom:6px;">
          Server Cache: <code>_categorization_cache_v3.json</code> · ${escapeHtml(savedAtStr)}
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;">
          <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-size:11px;font-weight:700;color:var(--ui-text-primary);">
            <input type="checkbox" id="chkCategorizeMasterVis" ${isVis ? "checked" : ""} />
            顯示 3D 地物分類圖層 (Show 3D Overlays)
          </label>
          <button type="button" class="btn-xs ${isVis ? "primary" : ""}" id="btnToggleCategorizeOverlayVis" style="padding:3px 8px;font-weight:700;">
            ${isVis ? "👁️ 顯示中 (點擊隱藏 3D 圖層)" : "👁️‍🗨️ 預設隱藏 (點擊顯示 3D 圖層)"}
          </button>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:4px;border-top:1px dashed rgba(56,189,248,0.25);">
          <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-size:10.5px;font-weight:700;color:#38bdf8;">
            <input type="checkbox" id="chkCategorizeLabelsVis" ${lblsVis ? "checked" : ""} />
            🏷️ 顯示 2D 浮動標籤 (Show 2D Floating Labels)
          </label>
          <span style="font-size:9.5px;color:var(--ui-text-muted);">${lblsVis ? "標籤開啟" : "僅保留 3D 幾何"}</span>
        </div>
      </div>

      <div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.35);border-radius:8px;padding:7px 9px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:5px;">
          <span style="font-size:10.5px;font-weight:800;color:#fbbf24;">🛠️ 手動新增 / 刪除分類 (Manual Edit · Saved on Server)</span>
          <button type="button" class="btn-xs" id="btnResetCategorizeManualEdits" style="padding:1px 6px;font-size:9.5px;" title="還原所有手動新增或刪除的項目 (Reset Manual Overrides)">
            ↺ 重設手動變更
          </button>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:5px;">
          <button type="button" class="btn-xs ${editMode === "add_tree" ? "primary" : ""}" data-cat-edit-mode="add_tree" style="flex:1;justify-content:center;font-size:10px;border-color:rgba(16,185,129,0.5);">
            ➕ 喬木 Tree
          </button>
          <button type="button" class="btn-xs ${editMode === "add_wall" ? "primary" : ""}" data-cat-edit-mode="add_wall" style="flex:1;justify-content:center;font-size:10px;border-color:rgba(244,63,94,0.5);">
            ➕ 擋土牆 Wall
          </button>
          <button type="button" class="btn-xs ${editMode === "add_road" ? "primary" : ""}" data-cat-edit-mode="add_road" style="flex:1;justify-content:center;font-size:10px;border-color:rgba(245,158,11,0.5);">
            ➕ 道路 Road
          </button>
          <button type="button" class="btn-xs ${editMode === "remove_click" ? "primary" : ""}" data-cat-edit-mode="remove_click" style="flex:1;justify-content:center;font-size:10px;border-color:rgba(239,68,68,0.5);color:#fca5a5;">
            🗑️ 點選刪除
          </button>
        </div>
        <div id="categorizeEditStatusHint" style="font-size:9.5px;color:${editMode ? "#fbbf24" : "var(--ui-text-muted)"};line-height:1.35;">
          ${escapeHtml(editStatusMsg)}
        </div>
      </div>

      <div style="background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.35);border-radius:8px;padding:8px 10px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:4px;">
          <span style="font-size:10.5px;font-weight:800;color:#34d399;">✨ ${escapeHtml(res.ai_model || "Gemini 3.6 Flash Multimodal + 3D Geometry")}</span>
          <span style="font-size:9.5px;padding:1px 6px;border-radius:99px;background:rgba(6,182,212,0.18);color:#22d3ee;font-weight:700;">RTK + 3D Verified</span>
        </div>
        <div style="font-size:11px;color:var(--ui-text-primary);line-height:1.42;margin-bottom:3px;">${escapeHtml(res.ai_summary_zh || "")}</div>
        <div style="font-size:10px;color:var(--ui-text-secondary);line-height:1.35;">${escapeHtml(res.ai_summary_en || "")}</div>
      </div>

      <div class="gs-metric-grid" style="grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
        <div class="gs-metric-box" style="border-left:3px solid #f59e0b;">
          <div class="lbl">🛣️ 道路鋪面 Roads (${s.roads_count || 0})</div>
          <div class="val" style="color:#fbbf24;font-size:13px;">${Number(s.roads_planar_area_m2 || 0).toLocaleString()} m²</div>
          <div style="font-size:9.5px;color:var(--ui-text-muted);">${Number(s.roads_planar_area_ping || 0).toLocaleString()} 坪 · 3D ${Number(s.roads_surface_area_3d_m2 || 0).toLocaleString()} m²</div>
        </div>
        <div class="gs-metric-box" style="border-left:3px solid #10b981;">
          <div class="lbl">🌳 喬木與胸徑 Trees (${s.trees_count || 0} 棵)</div>
          <div class="val" style="color:#34d399;font-size:13px;">DBH ${Number(s.trees_mean_dbh_cm || 0).toFixed(1)} cm</div>
          <div style="font-size:9.5px;color:var(--ui-text-muted);">Max ${Number(s.trees_max_dbh_cm || 0).toFixed(1)} cm · H ${Number(s.trees_mean_height_m || 0).toFixed(1)} m</div>
        </div>
        <div class="gs-metric-box" style="border-left:3px solid #06b6d4;">
          <div class="lbl">💧 水體與河道空洞 Water (${s.water_count || 0})</div>
          <div class="val" style="color:#22d3ee;font-size:13px;">${Number(s.water_count || 0) > 0 && s.water_level_twvd2001_m !== null && s.water_level_twvd2001_m !== undefined ? `+${Number(s.water_level_twvd2001_m).toFixed(2)} m` : "無水域 (None)"}</div>
          <div style="font-size:9.5px;color:var(--ui-text-muted);">${Number(s.water_count || 0) > 0 ? `${Number(s.water_planar_area_m2 || 0).toLocaleString()} m² (岸際等位面)` : "0 m² (乾燥陸域場址)"}</div>
        </div>
        <div class="gs-metric-box" style="border-left:3px solid #f43f5e;">
          <div class="lbl">🧱 擋土牆與垂直面 Walls (${s.walls_count || 0})</div>
          <div class="val" style="color:#fb7185;font-size:13px;">3D ${Number(s.walls_vertical_area_m2 || 0).toLocaleString()} m²</div>
          <div style="font-size:9.5px;color:var(--ui-text-muted);">總長 L ${Number(s.walls_total_length_m || 0).toFixed(1)} m · PCA 共面</div>
        </div>
      </div>

      <div style="background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:6px 8px;margin-bottom:8px;">
        <div style="font-size:10px;font-weight:700;color:var(--ui-text-secondary);margin-bottom:4px;">3D SCENE OVERLAY FILTERS (3D 子圖層開關)</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;font-size:10.5px;">
          <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#fbbf24;font-weight:600;">
            <input type="checkbox" data-cat-filter="roads" ${flt.roads ? "checked" : ""} /> 道路 (${(res.roads || []).length})
          </label>
          <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#34d399;font-weight:600;">
            <input type="checkbox" data-cat-filter="trees" ${flt.trees ? "checked" : ""} /> 喬木 DBH (${(res.trees || []).length})
          </label>
          <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#22d3ee;font-weight:600;">
            <input type="checkbox" data-cat-filter="water" ${flt.water ? "checked" : ""} /> 水域空洞 (${(res.water_bodies || []).length})
          </label>
          <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#fb7185;font-weight:600;">
            <input type="checkbox" data-cat-filter="walls" ${flt.walls ? "checked" : ""} /> 擋土牆 (${(res.walls || []).length})
          </label>
          <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#f59e0b;font-weight:600;">
            <input type="checkbox" data-cat-filter="stockpiles" ${flt.stockpiles ? "checked" : ""} /> 土石堆置 (${(res.stockpiles || []).length})
          </label>
        </div>
      </div>

      <div style="background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:6px 8px;margin-bottom:8px;">
        <div style="font-size:10px;font-weight:700;color:var(--ui-text-secondary);margin-bottom:3px;">SITE SURFACE BREAKDOWN (全場地物面積組成 · ${(s.triangle_count || 0).toLocaleString()} tris)</div>
        ${breakdownHtml}
      </div>

      <div style="display:flex;gap:3px;margin-bottom:5px;flex-wrap:wrap;">
        ${[
          ["all", "全部 All"],
          ["roads", "道路"],
          ["trees", "喬木 DBH"],
          ["water", "水域"],
          ["walls", "擋土牆"],
          ["stockpiles", "土石"],
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
              <th style="padding:4px 6px;">類別</th>
              <th style="padding:4px 6px;">主量測值</th>
              <th style="padding:4px 6px;">次要參數 (點擊定位)</th>
              <th style="padding:4px 4px;text-align:center;">刪除</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (r) => `
              <tr data-cat-fly="${escapeHtml(r.fly)}" data-cat-id="${escapeHtml(r.id || "")}" data-cat-label="${escapeHtml(r.label)}" style="cursor:pointer;border-top:1px solid rgba(148,163,184,0.14);" title="Click to fly 3D camera to ${escapeHtml(r.label)}">
                <td style="padding:4px 6px;font-family:monospace;">${r.badge}</td>
                <td style="padding:4px 6px;">${escapeHtml(r.type)}</td>
                <td style="padding:4px 6px;font-weight:700;">${escapeHtml(r.metric1)}</td>
                <td style="padding:4px 6px;color:var(--ui-text-secondary);">${escapeHtml(r.metric2)}</td>
                <td style="padding:3px 4px;text-align:center;">
                  ${
                    r.catType && r.catType !== "stockpiles"
                      ? `<button type="button" class="btn-xs" data-cat-delete-id="${escapeHtml(r.id || "")}" data-cat-delete-type="${escapeHtml(r.catType)}" title="刪除此分類項目 Remove ${escapeHtml(r.id || "")}" style="padding:1px 5px;font-size:10px;color:#fca5a5;border-color:rgba(239,68,68,0.35);">🗑️</button>`
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
            if (lblCollapse) lblCollapse.textContent = "▴ 展開";
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
      `<span>AI Surface &amp; Object Categorization (AI 地物分類)</span>`,
      `
      <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:7px 9px;margin-bottom:8px;line-height:1.42;">
        Combines <b>3D Mesh Geometry</b> (Bare-Earth DTM, 1.3m Breast-Height Trunk Slicing + Pratt Circle DBH, Un-Modelled Water Void Shoreline Clamping, 3D PCA Wall Coplanarity) with <b>Gemini 3.6 Flash Multimodal</b> verification.
      </div>
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <button type="button" class="gs-top-btn accent" style="flex:1;justify-content:center;" id="btnRunCategorize">
          <span>Analyze &amp; Show 3D Overlays (執行/顯示 AI 地物分類)</span>
        </button>
        <button type="button" class="btn-xs" id="btnRecomputeCategorize" title="Force Recompute &amp; Re-run Gemini Multimodal Analysis">
          <span>↻ Recompute</span>
        </button>
      </div>
      <div id="catResultContainer">
        <div style="padding:18px 10px;text-align:center;color:var(--ui-text-secondary);font-size:11.5px;">
          ⏳ Loading saved AI classification from server (or analyzing 3D mesh triangles)...
        </div>
      </div>
      `
    );

    const runCategorize = async (forceRecompute = false, explicitShowOverlays = null) => {
      const box = document.getElementById("catResultContainer");
      if (box && (forceRecompute || !STATE.lastCategorizeResult || STATE.lastCategorizeResult.scan_id !== activeScan.scan_id)) {
        box.innerHTML = `
          <div style="padding:18px 10px;text-align:center;color:var(--ui-text-secondary);font-size:11.5px;">
            ⏳ ${forceRecompute ? "Recomputing" : "Loading / Running"} 3D Geometric + Gemini Multimodal Categorization on <b>${escapeHtml(activeScan.name || activeScan.scan_id)}</b>...
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
        const waterToastStr =
          Number(s.water_count || 0) > 0 && s.water_level_twvd2001_m !== null && s.water_level_twvd2001_m !== undefined
            ? `${s.water_count} Water Zones (+${Number(s.water_level_twvd2001_m).toFixed(2)}m)`
            : `0 Water Zones`;
        const visTag = STATE.categorizeOverlayVisible ? "3D Overlays Visible" : "Saved on Server · Hidden by Default";
        showToast(
          `Categorized (${visTag}): ${s.roads_count || 0} Roads (${s.roads_planar_area_m2 || 0}m²), ${s.trees_count || 0} Trees (DBH ${s.trees_mean_dbh_cm || 0}cm), ${waterToastStr}, ${s.walls_count || 0} Walls`
        );
      } catch (err) {
        if (box) {
          box.innerHTML = `<div style="color:#ef4444;font-size:11.5px;padding:10px;">Categorization Error: ${escapeHtml(err.message)}</div>`;
        }
        showToast(`Categorization Error: ${err.message}`);
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
    add2DBadge(p1, `Section A`, "#ff3b30", { offsetY: -18, isProfile: true });

    if (!p2) {
      updateZoomInvariantElements();
      return;
    }

    add3DPinMarker(p2, 0x0284c7, studioThree.overlayGroup, addProfObj);
    const distM = p1.distanceTo(p2);
    add2DBadge(p2, `Section B (${distM.toFixed(2)}m)`, "#0284c7", { offsetY: -18, isProfile: true });

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

    return {
      status: "ok",
      scan_id: activeScan.scan_id,
      compare_scan_name: "Chord Grade Datum (A→B)",
      crs: "TWD97 (121) + TWVD2001",
      total_length_m: Number(totalLen.toFixed(2)),
      max_slope_pct: Number(maxSlopePct.toFixed(1)),
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
    if (window.innerWidth <= 768) {
      // Auto-minimize when opened from dock (p1 === null && p2 === null) so user can tap Section A & B on the 3D scan,
      // and auto-expand once Section A & B are placed (p1 && p2)!
      STATE.sidePanelMinimized = !(p1 && p2);
    } else {
      STATE.sidePanelMinimized = false;
    }
    const resolveEndpoints = () => {
      if (p1 && p2) return [p1, p2];
      if (STATE.profileEndpoints && STATE.profileEndpoints.length >= 2) return STATE.profileEndpoints;
      const def = getDefaultProfileEndpointsOnStudioMesh();
      STATE.profileEndpoints = def;
      return def;
    };

    showSidePanel(
      `<span>Cross-Section Profile</span>`,
      `
      <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:7px 9px;margin-bottom:8px;line-height:1.4;">
        Click <b>2 points (Section A &rarr; B)</b> on the 3D scan to sample TWVD2001 elevation &amp; slope along your custom section line. Hover over the chart to inspect any chainage station in 2D &amp; 3D.
      </div>
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <button type="button" class="gs-top-btn accent" style="flex:1.4;justify-content:center;" id="btnComputeProfileNow" title="Compute / Resample Cross-Section Profile">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          <span id="lblComputeProfileBtn">Compute Profile</span>
        </button>
        <button type="button" class="gs-top-btn" style="flex:1;justify-content:center;" id="btnNewProfileLine" title="Pick New Section A &rarr; B Line on 3D Scan">
          <span>New A&ndash;B Line</span>
        </button>
        <button type="button" class="gs-top-btn" style="flex:0.8;justify-content:center;" id="btnExportProfileCsv" title="Export Cross-Section CSV">
          <span>CSV</span>
        </button>
      </div>
      <div id="profileHoverReadout" style="font-size:11px;font-family:var(--font-mono);color:var(--ui-text-primary);background:var(--ui-bg-subtle);border:1px solid var(--ui-border);border-radius:6px;padding:5px 8px;margin-bottom:6px;display:flex;justify-content:space-between;">
        <span>Hover chart to inspect station</span>
        <span style="color:var(--ui-accent);">TWVD2001 (m)</span>
      </div>
      <canvas id="profileChartCanvas" width="336" height="196" style="width:100%;height:196px;background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;cursor:crosshair;"></canvas>
      <div class="gs-metric-grid" id="profileMetricsBox" style="margin-top:8px;"></div>
      `
    );

    const runProfileCalc = async () => {
      const btnLbl = document.getElementById("lblComputeProfileBtn");
      if (btnLbl) btnLbl.textContent = "Sampling...";
      const [ep1, ep2] = resolveEndpoints();

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
        if (btnLbl) btnLbl.textContent = "Compute Profile";
      }
    };

    document.getElementById("btnComputeProfileNow")?.addEventListener("click", () => {
      runProfileCalc().then(() => {
        const r = STATE.lastProfileResult;
        if (r) showToast(`Sampled Cross-Section Profile (${r.total_length_m} m, Max Grade ${r.max_slope_pct}%)`);
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
        if (lblCol) lblCol.textContent = "▴ 展開";
      }
      syncStudioMobileToolHud();
      showToast("Click Start Point A and End Point B on the 3D scan");
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

    await runProfileCalc();
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
    ctx.fillText("● Surface (TWVD2001)", padL, 10);
    ctx.fillStyle = "#0ea5e9";
    ctx.fillText("■ Fill", padL + 118, 10);
    ctx.fillStyle = "#ef4444";
    ctx.fillText("■ Cut", padL + 152, 10);
    ctx.fillStyle = isDark ? "#94a3b8" : "#64748b";
    ctx.fillText(`--- ${res.compare_scan_name || "Datum"}`, padL + 186, 10);

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
        readoutEl.innerHTML = `<span>Sta <b>${hs.chainage_m.toFixed(2)}m</b> · Grade <b>${hs.slope_pct}%</b></span><span style="color:var(--ui-accent);">H: <b>+${hs.elevation_m.toFixed(2)}m</b> (ΔZ ${hs.delta_z_m >= 0 ? "+" : ""}${hs.delta_z_m.toFixed(2)}m)</span>`;
      }
    } else if (readoutEl) {
      readoutEl.innerHTML = `<span>A: <b>+${samples[0].elevation_m.toFixed(2)}m</b> &rarr; B: <b>+${samples[samples.length - 1].elevation_m.toFixed(2)}m</b></span><span style="color:var(--ui-accent);">ΔH: <b>${(samples[samples.length - 1].elevation_m - samples[0].elevation_m >= 0 ? "+" : "") + (samples[samples.length - 1].elevation_m - samples[0].elevation_m).toFixed(2)}m</b></span>`;
    }
    ctx.restore();

    const maxAbsDz = Math.max(...samples.map((s) => Math.abs(s.delta_z_m || 0)));
    const mBox = document.getElementById("profileMetricsBox");
    if (mBox) {
      mBox.innerHTML = `
        <div class="gs-metric-box">
          <div class="lbl">Section Length</div>
          <div class="val" style="color:var(--ui-accent);">${res.total_length_m} m</div>
        </div>
        <div class="gs-metric-box">
          <div class="lbl">Max Local Grade</div>
          <div class="val">${res.max_slope_pct}%</div>
        </div>
        <div class="gs-metric-box">
          <div class="lbl">Elev Range (H)</div>
          <div class="val">+${rawMinZ.toFixed(2)}~+${rawMaxZ.toFixed(2)}m</div>
        </div>
        <div class="gs-metric-box">
          <div class="lbl">Max Relief ΔZ</div>
          <div class="val">${maxAbsDz.toFixed(2)} m</div>
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

  // 3E. Section Box Clipping Inspector (Auto-scaled to scan bounds + 6-plane clipping + 3D wireframe box)
  function openSectionBoxInspector() {
    setActiveStudioTool("section");
    STATE.sidePanelMinimized = false;
    const rawR = Math.max(20, computeStudioEffectiveBoundingRadius());
    const maxHoriz = Math.ceil(rawR * 1.35);
    const initHoriz = Math.ceil(rawR * 1.05);
    const maxElev = Math.max(25, Math.ceil(rawR * 0.75));
    const minElev = -Math.max(20, Math.ceil(rawR * 0.55));
    const initYTop = Math.ceil(maxElev * 0.85);
    const initYBot = Math.floor(minElev * 0.85);

    showSidePanel(
      `<span>Section Box Slicer (3D 剖面盒)</span>`,
      `
      <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-pill);border:1px solid var(--ui-border-strong);border-radius:7px;padding:7px 9px;margin-bottom:9px;line-height:1.4;">
        Auto-scaled to scan bounding radius (<b>${Math.round(rawR)} m</b>). Drag sliders to slice the 3D scan along X, Z, Top (+Y), and Bottom (-Y) planes.
      </div>
      <div class="gs-form-group">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <label>East-West Clipping Bound (±X m)</label>
          <span id="lblSecClipX" style="font-size:11px;font-family:var(--font-mono);color:var(--ui-accent);">±${initHoriz} m</span>
        </div>
        <input type="range" min="2" max="${maxHoriz}" step="1" value="${initHoriz}" class="gs-input" id="secClipX" />
      </div>
      <div class="gs-form-group">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <label>North-South Clipping Bound (±Z m)</label>
          <span id="lblSecClipZ" style="font-size:11px;font-family:var(--font-mono);color:var(--ui-accent);">±${initHoriz} m</span>
        </div>
        <input type="range" min="2" max="${maxHoriz}" step="1" value="${initHoriz}" class="gs-input" id="secClipZ" />
      </div>
      <div class="gs-form-group">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <label>Top Ceiling Bound (+Y Elevation m)</label>
          <span id="lblSecClipY" style="font-size:11px;font-family:var(--font-mono);color:var(--ui-accent);">+${initYTop} m</span>
        </div>
        <input type="range" min="${minElev}" max="${maxElev}" step="0.5" value="${initYTop}" class="gs-input" id="secClipY" />
      </div>
      <div class="gs-form-group">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <label>Bottom Floor Bound (-Y Elevation m)</label>
          <span id="lblSecClipYMin" style="font-size:11px;font-family:var(--font-mono);color:var(--ui-accent);">${initYBot} m</span>
        </div>
        <input type="range" min="${minElev}" max="${maxElev}" step="0.5" value="${initYBot}" class="gs-input" id="secClipYMin" />
      </div>
      <label style="display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--ui-text-primary);cursor:pointer;margin:8px 0 10px;">
        <input type="checkbox" id="chkKeepSectionClip" ${STATE.keepSectionBoxClip ? "checked" : ""} />
        <span>Keep Clipping Active When Panel Closed (關閉面板後保留剖面裁切)</span>
      </label>
      <button type="button" class="gs-top-btn" id="btnResetSectionBox" style="width:100%;justify-content:center;" title="Reset Clipping Planes">
        <span>Reset Section Box</span>
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
      wireframe.position.set(0, 0.5 * (yMin + yMax), 0);
      wireframe.renderOrder = 997;
      studioThree.overlayGroup.add(wireframe);
      studioThree._sectionBoxHelper = wireframe;
    };

    const updateClip = () => {
      if (!studioThree) return;
      const cx = parseFloat(document.getElementById("secClipX")?.value || String(initHoriz));
      const cz = parseFloat(document.getElementById("secClipZ")?.value || String(initHoriz));
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
        new THREE.Plane(new THREE.Vector3(-1, 0, 0), cx),
        new THREE.Plane(new THREE.Vector3(1, 0, 0), cx),
        new THREE.Plane(new THREE.Vector3(0, -1, 0), cyTop),
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -cyBot),
        new THREE.Plane(new THREE.Vector3(0, 0, -1), cz),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), cz),
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
      showToast("Section Box clipping reset");
    });

    updateClip();
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

  // 3G. Staged Scan Editing Suite:
  //   1. Lasso Delete (`openLassoDeleteInspector`) — mark multiple polygons/lassos -> press Delete -> instant 3D preview (NO Mesh Optimizer inside!)
  //   2. Lasso Keep (`openLassoKeepInspector`) — mark keep boundary -> stage crop & instant 3D preview
  //   3. Mesh Compression (`openMeshCompressionInspector`) — stage compression preset
  //   4. Coordinate System (`openCoordinateSystemInspector`) — stage CRS & custom datum offset
  //   5. Generate Scan (`openGenerateScanInspector`) — build a brand-new scan once with all staged adjustments!

  const CRS_UI_CATALOG = [
    {
      code: "TWD97_121_TWVD2001",
      shortLabel: "TWD97 (121) + TWVD2001",
      fullLabel: "TWD97 / TM2 Zone 121 + TWVD2001 (EPSG:3826+8904)",
      kind: "tm",
      lon0: 121.0,
      fe: 250000.0,
      k0: 0.9999,
      fInv: 298.257222101,
      hOff: 0.0,
    },
    {
      code: "TWD97_119_TWVD2001",
      shortLabel: "TWD97 (119) + TWVD2001",
      fullLabel: "TWD97 / TM2 Zone 119 + TWVD2001 (EPSG:3825+8904 · Offshore)",
      kind: "tm",
      lon0: 119.0,
      fe: 250000.0,
      k0: 0.9999,
      fInv: 298.257222101,
      hOff: 0.0,
    },
    {
      code: "WGS84_UTM51N",
      shortLabel: "WGS84 / UTM 51N",
      fullLabel: "WGS84 / UTM Zone 51N (EPSG:32651 · International)",
      kind: "tm",
      lon0: 123.0,
      fe: 500000.0,
      k0: 0.9996,
      fInv: 298.257223563,
      hOff: 20.6,
    },
    {
      code: "WGS84_UTM50N",
      shortLabel: "WGS84 / UTM 50N",
      fullLabel: "WGS84 / UTM Zone 50N (EPSG:32650)",
      kind: "tm",
      lon0: 117.0,
      fe: 500000.0,
      k0: 0.9996,
      fInv: 298.257223563,
      hOff: 19.8,
    },
    {
      code: "LOCAL_ORIGIN",
      shortLabel: "Local Origin (0,0,0)",
      fullLabel: "Local Site Origin (0, 0, 0) Meters (BIM / Revit / Rhino)",
      kind: "local",
      hOff: 0.0,
    },
  ];

  const COMPRESSION_PRESET_LABELS = {
    quality: "High Fidelity (75% Tris · 2K JPEG)",
    balanced: "Balanced Stream (50% Tris · 1.5K JPEG)",
    web: "Fast Mobile / Field (35% Tris · 1K JPEG)",
    ultra_light: "Ultra-Light Offline (20% Tris · 768px)",
  };

  function inferActiveScanCrsCode(scanObj) {
    const s = scanObj || STATE.activeScan || {};
    const raw = String(s.crs || "").toUpperCase();
    const ce = s.twd97_e !== undefined && s.twd97_e !== null ? Number(s.twd97_e) : 0;
    const cn = s.twd97_n !== undefined && s.twd97_n !== null ? Number(s.twd97_n) : 0;
    if (raw.includes("LOCAL") || (Math.abs(ce) < 50000 && Math.abs(cn) < 50000)) return "LOCAL_ORIGIN";
    if (raw.includes("UTM") && raw.includes("50")) return "WGS84_UTM50N";
    if (raw.includes("UTM") || raw.includes("32651")) return "WGS84_UTM51N";
    if (raw.includes("119") || raw.includes("3825")) return "TWD97_119_TWVD2001";
    return "TWD97_121_TWVD2001";
  }

  function wgs84ToTransverseMercatorJS(latDeg, lonDeg, lon0Deg, fe, k0, fInv) {
    const a = 6378137.0;
    const f = 1.0 / fInv;
    const e2 = 2 * f - f * f;
    const ep2 = e2 / (1 - e2);
    const lat = (latDeg * Math.PI) / 180.0;
    const lon = (lonDeg * Math.PI) / 180.0;
    const lon0 = (lon0Deg * Math.PI) / 180.0;
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const tanLat = Math.tan(lat);
    const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    const t = tanLat * tanLat;
    const c = ep2 * cosLat * cosLat;
    const A = cosLat * (lon - lon0);
    const M =
      a *
      ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256) * lat -
        ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 * e2 * e2) / 1024) * Math.sin(2 * lat) +
        ((15 * e2 * e2) / 256 + (45 * e2 * e2 * e2) / 1024) * Math.sin(4 * lat) -
        ((35 * e2 * e2 * e2) / 3072) * Math.sin(6 * lat));
    const easting =
      fe +
      k0 *
        n *
        (A + ((1 - t + c) * Math.pow(A, 3)) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * ep2) * Math.pow(A, 5)) / 120);
    const northing =
      k0 *
      (M +
        n *
          tanLat *
          (Math.pow(A, 2) / 2 +
            ((5 - t + 9 * c + 4 * c * c) * Math.pow(A, 4)) / 24 +
            ((61 - 58 * t + t * t + 600 * c - 330 * ep2) * Math.pow(A, 6)) / 720));
    return { e: easting, n: northing };
  }

  function hasValidGeorefLatLon(scanObj) {
    const s = scanObj || STATE.activeScan || {};
    if (s.lat === null || s.lat === undefined || s.lon === null || s.lon === undefined) return false;
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      (Math.abs(lat) > 1e-5 || Math.abs(lon) > 1e-5) &&
      Math.abs(lat) <= 90.0 &&
      Math.abs(lon) <= 180.0
    );
  }

  function previewTargetCrsCenterJS(scanObj, targetCode, offX = 0, offY = 0, offZ = 0) {
    const s = scanObj || STATE.activeScan || {};
    const srcCode = inferActiveScanCrsCode(s);
    const srcDef = CRS_UI_CATALOG.find((c) => c.code === srcCode) || CRS_UI_CATALOG[0];
    const tgtDef = CRS_UI_CATALOG.find((c) => c.code === targetCode) || CRS_UI_CATALOG[0];
    const ce = s.twd97_e !== undefined && s.twd97_e !== null ? Number(s.twd97_e) : 0;
    const cn = s.twd97_n !== undefined && s.twd97_n !== null ? Number(s.twd97_n) : 0;
    const ch = s.twd97_h !== undefined && s.twd97_h !== null ? Number(s.twd97_h) : 0;
    const twvdH = ch - (srcDef.hOff || 0);

    if (tgtDef.code === srcCode) {
      return { x: ce + offX, y: cn + offY, z: ch + offZ, crsLabel: tgtDef.shortLabel };
    }
    if (tgtDef.kind === "local") {
      return { x: 0 + offX, y: 0 + offY, z: 0 + offZ, crsLabel: tgtDef.shortLabel };
    }
    if (!hasValidGeorefLatLon(s)) {
      return {
        error:
          "Scan uses Local Origin (0,0,0) with no WGS84/RTK georeference — cannot project to geodetic CRS without georeferencing.",
        crsLabel: tgtDef.shortLabel,
      };
    }
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    const en = wgs84ToTransverseMercatorJS(lat, lon, tgtDef.lon0, tgtDef.fe, tgtDef.k0, tgtDef.fInv);
    return {
      x: en.e + offX,
      y: en.n + offY,
      z: twvdH + (tgtDef.hOff || 0) + offZ,
      crsLabel: tgtDef.shortLabel,
    };
  }

  function countMarkedRegionsPending() {
    const addStrokes = Array.isArray(STATE.lassoStrokes)
      ? STATE.lassoStrokes.filter((s) => s.op !== "sub").length
      : 0;
    const lockedPolys = Array.isArray(STATE.pendingCropPolygons) ? STATE.pendingCropPolygons.length : 0;
    const unclosedPoly = Array.isArray(STATE.measurePoints) && STATE.measurePoints.length >= 3 ? 1 : 0;
    return addStrokes + lockedPolys + unclosedPoly;
  }

  function serializeMultiAlignLayersForMerge(forceLockAll = false) {
    return (STATE.multiAlign?.layers || []).map((l) => {
      applyLayerTransformTo3D(l);
      const pos = l.layerGroup
        ? l.layerGroup.position
        : { x: Number(l.tx) || 0, y: Number(l.ty) || 0, z: Number(l.tz) || 0 };
      const quat = l.layerGroup ? l.layerGroup.quaternion : { x: 0, y: 0, z: 0, w: 1 };
      return {
        scan_id: l.scan_id,
        locked: forceLockAll ? true : Boolean(l.locked),
        tx: Number(l.tx) || 0,
        ty: Number(l.ty) || 0,
        tz: Number(l.tz) || 0,
        rx_deg: Number(l.rx_deg) || 0,
        ry_deg: Number(l.ry_deg) || 0,
        rz_deg: Number(l.rz_deg) || 0,
        raw_center_zup: l.rawCenter ? [Number(l.rawCenter.x), Number(l.rawCenter.y), Number(l.rawCenter.z)] : null,
        position_three: [Number(pos.x) || 0, Number(pos.y) || 0, Number(pos.z) || 0],
        quaternion_three: [Number(quat.x) || 0, Number(quat.y) || 0, Number(quat.z) || 0, Number(quat.w ?? 1)],
        euler_deg_three: [Number(l.rx_deg) || 0, Number(l.ry_deg) || 0, Number(l.rz_deg) || 0],
      };
    });
  }

  function commitPendingLassoMarksToStagedEdits(modeOverride = null) {
    const mode =
      modeOverride ||
      (!STATE.multiAlign?.active && STATE.cropMode === "keep_inside" ? "keep_inside" : "delete_inside");
    const st = ensureStagedEditsForActiveScan();

    if (mode === "keep_inside" && !STATE.multiAlign?.active) {
      const effVis = getEffectiveLassoVisibleOnly("keep_inside");
      const batchStrokes = (STATE.lassoStrokes || []).map((s) => Object.assign({}, s, { visible_only: effVis }));
      const batchPolys = [];
      const rawKeepPolys = [];
      (STATE.pendingCropPolygons || []).forEach((pts) => {
        if (Array.isArray(pts) && pts.length >= 3) rawKeepPolys.push(pts);
      });
      if (Array.isArray(STATE.measurePoints) && STATE.measurePoints.length >= 3) {
        rawKeepPolys.push(STATE.measurePoints);
      }
      if (rawKeepPolys.length > 0 && isActiveStudioTilesetEcef()) {
        rawKeepPolys.forEach((pts) => {
          const orthoSt = planPolygonToTopDownFrustumStroke(pts);
          if (orthoSt) batchStrokes.push(orthoSt);
        });
      } else {
        rawKeepPolys.forEach((pts) => {
          batchPolys.push(pts.map((p) => studioWorldToTilesetNative(p).slice(0, 2)));
        });
      }
      const regionCount = batchStrokes.filter((s) => s.op !== "sub").length + batchPolys.length;
      if (regionCount === 0) return { committed: 0, triCount: 0, mode };
      const triEst = Number(STATE.lassoSelectedTriCount || 0);
      st.cropKeep = {
        regionCount,
        triCount: triEst,
        frustum_strokes: batchStrokes,
        native_polygons: batchPolys,
      };
      st.rev++;
      STATE.measurePoints = [];
      clearLassoSelectionState();
      applyStagedEditsToStudioMeshes(true);
      syncStagedEditsDockBadge();
      return { committed: regionCount, triCount: triEst, mode };
    }

    const effVis = getEffectiveLassoVisibleOnly("delete_inside");
    const batchStrokes = (STATE.lassoStrokes || []).map((s) => Object.assign({}, s, { visible_only: effVis }));
    const rawWorldPolys = [];
    if (Array.isArray(STATE.pendingCropPolygons)) {
      STATE.pendingCropPolygons.forEach((pts) => {
        if (Array.isArray(pts) && pts.length >= 3) rawWorldPolys.push(pts);
      });
    }
    if (Array.isArray(STATE.measurePoints) && STATE.measurePoints.length >= 3) {
      rawWorldPolys.push(STATE.measurePoints);
    }

    const batchPolys = [];
    let layerCenteredPolygons = null;
    if (STATE.multiAlign?.active && rawWorldPolys.length > 0) {
      if (studioThree?.multiAlignGroup) studioThree.multiAlignGroup.updateMatrixWorld(true);
      layerCenteredPolygons = {};
      (STATE.multiAlign.layers || []).forEach((layer) => {
        if (!layer || !layer.visible || !layer.zUpGroup) return;
        const invZUp = layer.zUpGroup.matrixWorld.clone().invert();
        layerCenteredPolygons[layer.scan_id] = rawWorldPolys.map((pts) =>
          pts.map((p) => {
            const loc = p.clone().applyMatrix4(invZUp);
            return [loc.x, loc.y];
          })
        );
      });
    } else if (rawWorldPolys.length > 0 && isActiveStudioTilesetEcef()) {
      rawWorldPolys.forEach((pts) => {
        const orthoSt = planPolygonToTopDownFrustumStroke(pts);
        if (orthoSt) batchStrokes.push(orthoSt);
      });
    } else {
      rawWorldPolys.forEach((pts) => {
        batchPolys.push(
          pts.map((p) => {
            const n = studioWorldToTilesetNative(p);
            return [n[0], n[1]];
          })
        );
      });
    }

    const regionCount =
      batchStrokes.filter((s) => s.op !== "sub").length +
      batchPolys.length +
      (layerCenteredPolygons ? rawWorldPolys.length : 0);
    if (regionCount === 0) return { committed: 0, triCount: 0, mode: "delete_inside" };

    const markedTriEstimate = Number(STATE.lassoSelectedTriCount || 0);
    const delBatch = {
      id: Date.now(),
      regionCount,
      triCount: markedTriEstimate,
      frustum_strokes: batchStrokes,
      native_polygons: batchPolys,
    };
    if (layerCenteredPolygons) {
      delBatch.layer_centered_polygons = layerCenteredPolygons;
    }
    st.deletions.push(delBatch);
    st.rev++;

    STATE.measurePoints = [];
    clearLassoSelectionState();
    applyStagedEditsToStudioMeshes(true);
    syncStagedEditsDockBadge();
    return { committed: regionCount, triCount: markedTriEstimate, mode: "delete_inside" };
  }

  function renderStagedAdjustmentsCardHtml(opts = {}) {
    const st = ensureStagedEditsForActiveScan();
    const isMulti = Boolean(STATE.multiAlign?.active);
    const pendingMarks = countMarkedRegionsPending();
    const pendingMarkTris = Number(STATE.lassoSelectedTriCount || 0);
    const totalAdj = countStagedAdjustments() + (pendingMarks > 0 && st.deletions.length === 0 && !st.cropKeep ? 1 : 0);
    const alwaysShow = Boolean(opts.alwaysShow);
    if (!alwaysShow && totalAdj === 0) return "";

    const totalDelRegions = st.deletions.reduce((acc, b) => acc + (Number(b.regionCount) || 1), 0);
    const totalDelTris = st.deletions.reduce((acc, b) => acc + (Number(b.triCount) || 0), 0);
    const crsItem = st.crsConfig
      ? CRS_UI_CATALOG.find((c) => c.code === st.crsConfig.target_crs) || CRS_UI_CATALOG[0]
      : null;
    const crsOffText =
      st.crsConfig &&
      (Math.abs(st.crsConfig.offset_x || 0) > 1e-4 ||
        Math.abs(st.crsConfig.offset_y || 0) > 1e-4 ||
        Math.abs(st.crsConfig.offset_z || 0) > 1e-4)
        ? ` + Δ(${Number(st.crsConfig.offset_x).toFixed(2)}, ${Number(st.crsConfig.offset_y).toFixed(2)}, ${Number(
            st.crsConfig.offset_z
          ).toFixed(2)})m`
        : "";

    const itemsHtml = [];
    if (isMulti) {
      const nLayers = Array.isArray(STATE.multiAlign?.layers) ? STATE.multiAlign.layers.length : 0;
      itemsHtml.push(`
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;font-size:11px;">
          <span>🔗 <b>Combine Scans:</b> ${nLayers} scan layer${nLayers === 1 ? "" : "s"} ${
        nLayers < 2 ? '<span style="color:#f59e0b;">(add 1+ scan in Align &amp; Merge)</span>' : "(aligned)"
      }</span>
          <button type="button" class="gs-top-btn" data-jump-edit="align_merge" style="padding:1px 6px;font-size:10px;" title="Open Multi-Scan Align &amp; Merge">Align</button>
        </div>
      `);
    }
    if (st.deletions.length > 0) {
      itemsHtml.push(`
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;font-size:11px;">
          <span>🗑️ <b>Delete:</b> ${totalDelRegions} region${totalDelRegions === 1 ? "" : "s"} (${totalDelTris.toLocaleString()} tris)</span>
          <button type="button" class="gs-top-btn" data-unstage="deletions" style="padding:1px 6px;font-size:10px;" title="Remove all staged deletions">✕</button>
        </div>
      `);
    }
    if (pendingMarks > 0) {
      itemsHtml.push(`
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.35);border-radius:6px;font-size:11px;">
          <span>🔴 <b>Selected Polygons:</b> ${pendingMarks} region${pendingMarks === 1 ? "" : "s"} (${pendingMarkTris.toLocaleString()} tris · preserved)</span>
          <button type="button" class="gs-top-btn" data-stage-pending-marks="1" style="padding:1px 7px;font-size:10px;border-color:rgba(239,68,68,0.45);color:#ef4444;" title="Apply these selected polygons to the 3D delete preview now">Delete Now</button>
        </div>
      `);
    }
    if (!isMulti && st.cropKeep) {
      itemsHtml.push(`
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;font-size:11px;">
          <span>✂️ <b>Keep Crop:</b> ${st.cropKeep.regionCount || 1} region(s) (${Number(st.cropKeep.triCount || 0).toLocaleString()} tris)</span>
          <button type="button" class="gs-top-btn" data-unstage="cropKeep" style="padding:1px 6px;font-size:10px;" title="Remove staged keep crop">✕</button>
        </div>
      `);
    }
    if (st.compressionPreset && st.compressionPreset !== "none") {
      itemsHtml.push(`
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;font-size:11px;">
          <span>⚡ <b>Compression:</b> ${escapeHtml(COMPRESSION_PRESET_LABELS[st.compressionPreset] || st.compressionPreset)}</span>
          <button type="button" class="gs-top-btn" data-unstage="compression" style="padding:1px 6px;font-size:10px;" title="Remove staged compression">✕</button>
        </div>
      `);
    }
    if (st.crsConfig) {
      itemsHtml.push(`
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;font-size:11px;">
          <span>🌐 <b>CRS:</b> ${escapeHtml((crsItem ? crsItem.shortLabel : st.crsConfig.target_crs) + crsOffText)}</span>
          <button type="button" class="gs-top-btn" data-unstage="crs" style="padding:1px 6px;font-size:10px;" title="Remove staged CRS change">✕</button>
        </div>
      `);
    }

    const defaultNewName = st.newScanName || `${STATE.activeScan?.name || STATE.activeScanId || "Scan"}`;
    const canGenerate = isMulti
      ? Array.isArray(STATE.multiAlign?.layers) && STATE.multiAlign.layers.length >= 2
      : totalAdj > 0;

    return `
      <div style="background:rgba(2,132,199,0.08);border:1px solid rgba(2,132,199,0.35);border-radius:8px;padding:10px;margin-top:10px;">
        <div style="font-size:12px;font-weight:700;color:var(--ui-accent);display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;flex-wrap:wrap;">
          <span>✨ Pending Adjustments (${totalAdj})</span>
          <span style="font-size:10px;color:var(--ui-text-secondary);" title="The untouched original scan is safely moved to the Trash Bin where you can restore it anytime">🗑️ Original${isMulti ? "s" : ""} → Trash Bin</span>
        </div>
        ${
          itemsHtml.length > 0
            ? `<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px;">${itemsHtml.join("")}</div>`
            : `<div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-surface);border:1px dashed var(--ui-border-strong);border-radius:6px;padding:8px;margin-bottom:8px;">
                No adjustments staged yet. Use <b>Lasso Delete (套索刪除)</b>, <b>Mesh Compression (網格優化)</b>, or <b>Coordinate System (座標系統)</b> on the left dock first, then press <b>Save Edits</b>!
              </div>`
        }
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">
          ${
            isMulti
              ? `<button type="button" class="gs-top-btn" data-jump-edit="align_merge" style="font-size:10.5px;padding:3px 7px;">🎯 Return to Alignment</button>`
              : ""
          }
          <button type="button" class="gs-top-btn" data-jump-edit="crop_delete" style="font-size:10.5px;padding:3px 7px;">+ Delete Regions</button>
          <button type="button" class="gs-top-btn" data-jump-edit="optimizer" style="font-size:10.5px;padding:3px 7px;">+ Compression</button>
          <button type="button" class="gs-top-btn" data-jump-edit="crs" style="font-size:10.5px;padding:3px 7px;">+ Coordinate System</button>
        </div>
        <div class="gs-form-group" style="margin-bottom:8px;">
          <label style="font-size:11px;">Scan Name (掃描名稱 · 原掃描將自動備份至回收桶)</label>
          <input type="text" class="gs-input" id="txtGenerateScanName" value="${escapeHtml(defaultNewName)}" placeholder="Enter scan name..." />
        </div>
        <button type="button" class="gs-top-btn accent" id="btnGenerateStagedScan" style="width:100%;justify-content:center;padding:9px 12px;font-weight:700;${
          !canGenerate ? "opacity:0.5;pointer-events:none;" : ""
        }" ${!canGenerate ? "disabled" : ""} title="Save edited scan and move untouched original backup to Trash Bin (easily restorable)">
          <span>💾 ${isMulti ? `Save Merged Scan (${totalAdj} step${totalAdj === 1 ? "" : "s"} · 合併並儲存)` : `Save Edits (${totalAdj} adjustment${totalAdj === 1 ? "" : "s"} · 儲存變更)`}</span>
        </button>
        <div id="generateScanResultBox" style="margin-top:8px;"></div>
      </div>
    `;
  }

  function bindStagedAdjustmentsCardEvents(rerenderFn) {
    const st = ensureStagedEditsForActiveScan();
    const nameInput = document.getElementById("txtGenerateScanName");
    if (nameInput) {
      nameInput.addEventListener("input", () => {
        st.newScanName = nameInput.value;
      });
    }

    document.querySelectorAll("[data-stage-pending-marks]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const res = commitPendingLassoMarksToStagedEdits();
        if (res.committed > 0) {
          showToast(`Staged ${res.committed} selected region(s) for deletion`);
        }
        if (typeof rerenderFn === "function") rerenderFn();
      });
    });

    document.querySelectorAll("[data-unstage]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.getAttribute("data-unstage");
        if (kind === "deletions") {
          st.deletions = [];
          st.rev++;
          applyStagedEditsToStudioMeshes(true);
        } else if (kind === "cropKeep") {
          st.cropKeep = null;
          st.rev++;
          applyStagedEditsToStudioMeshes(true);
        } else if (kind === "compression") {
          st.compressionPreset = null;
        } else if (kind === "crs") {
          st.crsConfig = null;
        }
        syncStagedEditsDockBadge();
        if (typeof rerenderFn === "function") rerenderFn();
      });
    });

    document.querySelectorAll("[data-jump-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-jump-edit");
        preserveLassoSelectionBeforeToolSwitch();
        if (target === "align_merge") {
          setActiveStudioTool("align_merge");
          openAlignMergeInspector();
        } else if (target === "crop_delete") {
          STATE.cropMode = "delete_inside";
          openLassoDeleteInspector({ armLasso: true });
        } else if (target === "optimizer") {
          setActiveStudioTool("optimizer");
          openMeshCompressionInspector();
        } else if (target === "crs") {
          setActiveStudioTool("crs");
          openCoordinateSystemInspector();
        }
      });
    });

    document.getElementById("btnGenerateStagedScan")?.addEventListener("click", async () => {
      await executeGenerateStagedScan();
    });
  }

  async function executeGenerateStagedScan() {
    const st = ensureStagedEditsForActiveScan();
    const isMulti = Boolean(STATE.multiAlign?.active);

    if (countMarkedRegionsPending() > 0) {
      commitPendingLassoMarksToStagedEdits();
    }

    if (isMulti) {
      if (!Array.isArray(STATE.multiAlign.layers) || STATE.multiAlign.layers.length < 2) {
        showToast("Please add at least 2 scans in Align & Merge before saving a merged scan.");
        return;
      }
      if (STATE.multiAlign.layers.some((l) => !l.ready)) {
        showToast("Please wait a moment for all 3D scan layers to finish loading their bounds.");
        return;
      }
    } else if (countStagedAdjustments() === 0) {
      showToast("Stage at least one adjustment (Delete, Compression, or CRS) before saving edits.");
      return;
    }

    const nameEl = document.getElementById("txtGenerateScanName");
    const newScanName = String(nameEl?.value || st.newScanName || `${STATE.activeScan?.name || "Scan"}`).trim();
    st.newScanName = newScanName;

    const btnGen = document.getElementById("btnGenerateStagedScan");
    if (btnGen) {
      btnGen.disabled = true;
      btnGen.innerHTML = `<span>⏳ ${isMulti ? "Merging & Saving Scan on PC..." : "Saving Edits & Backing Up Original to Trash Bin..."}</span>`;
    }
    const resBox = document.getElementById("generateScanResultBox");
    if (resBox) {
      resBox.innerHTML = `<div style="font-size:11.5px;color:var(--ui-accent);">Saving "${escapeHtml(
        newScanName
      )}" with all staged edits (moving untouched original backup${isMulti ? "s" : ""} to Trash Bin)...</div>`;
    }

    try {
      let res = null;
      if (isMulti) {
        const curSite =
          (STATE.activeProjectGroup && STATE.activeProjectGroup !== "__all__" ? STATE.activeProjectGroup : "") ||
          STATE.multiAlign.layers[0]?.project_group ||
          STATE.activeScan?.project_group ||
          "Unassigned Site";
        const serializedLayers = serializeMultiAlignLayersForMerge(true);
        const refC = STATE.multiAlign.refCenter || STATE.multiAlign.layers[0]?.rawCenter || null;
        res = await apiPost("/api/scans/merge", {
          name: newScanName,
          new_scan_name: newScanName,
          project_group: curSite,
          ref_center_zup: refC ? [Number(refC.x), Number(refC.y), Number(refC.z)] : null,
          layers: serializedLayers,
          scans: serializedLayers,
          deletions: st.deletions,
          compression_preset: st.compressionPreset || "",
          crs_config: st.crsConfig || null,
          archive_originals_to_bin: Boolean(STATE.multiAlign.archiveOriginals),
        });
        STATE.multiAlign.lastMergedScan = res.scan || {
          scan_id: res.scan_id,
          name: newScanName,
          project_group: curSite,
        };
      } else {
        const payload = {
          scan_id: STATE.activeScanId,
          new_scan_name: newScanName,
          deletions: st.deletions,
          crop_keep: st.cropKeep || null,
          compression_preset: st.compressionPreset || "",
          crs_config: st.crsConfig || null,
          archive_original_to_bin: true,
        };
        res = await apiPost("/api/optimizer/generate-scan", payload);
      }

      clearLassoSelectionState();
      restoreOriginalStudioMeshIndices();
      if (isMulti) {
        exitMultiScanAlignMode(false);
      }
      setActiveStudioTool("orbit");

      if (typeof res.bin_scans_count === "number") {
        updateRecycleBinBadges(res.bin_scans_count);
      } else if (Array.isArray(res.bin_scans)) {
        updateRecycleBinBadges(res.bin_scans.length);
      }

      if (Array.isArray(res.scans)) {
        STATE.scans = res.scans;
      } else {
        await refreshScansCatalog();
      }
      if (Array.isArray(res.projects)) {
        STATE.projects = res.projects;
      }
      populateProjectScanDropdowns(res.scan?.project_group || STATE.activeProjectGroup, res.scan_id || res.scan?.scan_id || "");
      renderMapClusters();

      const createdId = res.scan_id || res.scan?.scan_id;
      if (createdId) {
        loadScanIntoStudio(createdId);
      }

      const outMb = res.output_mb ?? res.glb_size_mb ?? 0;
      const backupMsg = isMulti
        ? `${Number(res.archived_to_bin_count || 0)} original scan backup(s) moved to Trash Bin`
        : res.archived_to_bin
        ? `Original scan backup ("${escapeHtml(res.trashed_backup?.name || "Original Backup")}") moved to Trash Bin`
        : "Original scan backup preserved";
      showSidePanel(
        `<span>✓ Edits Saved · Backup in Trash Bin (變更已儲存)</span>`,
        `
        <div style="background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.38);border-radius:8px;padding:12px;font-size:12px;color:var(--ui-text-primary);">
          <div style="color:#10b981;font-weight:700;font-size:13px;margin-bottom:6px;">✓ Saved "${escapeHtml(
            res.scan?.name || newScanName
          )}" (${res.duration_s}s)</div>
          <div style="margin-bottom:4px;">Scan ID: <code>${escapeHtml(createdId || "")}</code></div>
          <div style="margin-bottom:4px;">Coordinate System: <b>${escapeHtml(res.crs || res.scan?.crs || "TWD97 (121) + TWVD2001")}</b></div>
          <div style="margin-bottom:6px;">Output Size: <b>${outMb} MB</b></div>
          <div style="margin-bottom:8px;padding:6px 8px;border-radius:6px;background:var(--ui-bg-surface);border:1px solid var(--ui-border);font-size:11px;color:var(--ui-text-secondary);">
            🗑️ <b>Backup in Trash Bin:</b> ${backupMsg}. Easily restore it anytime from the Trash Bin.
          </div>
          <button type="button" class="gs-top-btn" id="btnOpenBinAfterSaveEdit" style="width:100%;justify-content:center;margin-bottom:8px;font-size:11.5px;">
            <span>🗑️ Open Trash Bin to View / Restore Backup (開啟回收桶)</span>
          </button>
          <div style="font-size:11px;color:var(--ui-text-secondary);border-top:1px solid var(--ui-border);padding-top:6px;">
            <b>Applied Adjustments:</b>
            <ul style="margin:4px 0 0 16px;padding:0;">
              ${(res.applied_adjustments || []).map((a) => `<li>${escapeHtml(a)}</li>`).join("")}
            </ul>
          </div>
        </div>
        `
      );
      document.getElementById("btnOpenBinAfterSaveEdit")?.addEventListener("click", () => {
        openRecycleBinModal();
      });
      showToast(`Saved "${res.scan?.name || newScanName}" — original backup sent to Trash Bin!`);
    } catch (err) {
      if (resBox) {
        resBox.innerHTML = `<div style="font-size:11.5px;color:#ef4444;">Save Edits Error: ${escapeHtml(err.message)}</div>`;
      }
      if (btnGen) {
        btnGen.disabled = false;
        btnGen.innerHTML = `<span>💾 Save Edits (儲存變更)</span>`;
      }
      showToast(`Save Edits Error: ${err.message}`);
    }
  }

  function openLassoDeleteInspector(opts = {}) {
    const armLasso = opts && opts.armLasso !== undefined ? Boolean(opts.armLasso) : true;
    STATE.cropMode = "delete_inside";
    if (armLasso) {
      if (STATE.activeTool !== "crop_delete") setActiveStudioTool("crop_delete");
    } else if (STATE.activeTool === "crop_delete" || STATE.activeTool === "crop") {
      setActiveStudioTool("orbit");
    }

    const st = ensureStagedEditsForActiveScan();
    const isLassoActive = STATE.activeTool === "crop_delete";
    const inputMethod = STATE.lassoInputMethod || "lasso";
    const visibleOnlyChecked = getEffectiveLassoVisibleOnly("delete_inside");
    const markedCount = countMarkedRegionsPending();
    const triCountLabel = `${Number(STATE.lassoSelectedTriCount || 0).toLocaleString()} tris`;
    const isMobView = window.innerWidth <= 768;
    if (isMobView) {
      if (isLassoActive && markedCount === 0 && !opts.keepExpanded) {
        STATE.sidePanelMinimized = true;
      } else if (!isLassoActive) {
        STATE.sidePanelMinimized = false;
      }
    } else {
      STATE.sidePanelMinimized = false;
    }

    const totalStagedDelRegions = st.deletions.reduce((acc, b) => acc + (Number(b.regionCount) || 1), 0);
    const totalStagedDelTris = st.deletions.reduce((acc, b) => acc + (Number(b.triCount) || 0), 0);
    const activeScanObj = STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || STATE.activeScan;
    const canRestoreFromOriginal =
      !STATE.multiAlign?.active &&
      ((Array.isArray(activeScanObj?.merged_from) && activeScanObj.merged_from.length > 0) ||
        Boolean(activeScanObj?.derived_from_scan_id));
    const restoreConnChecked = STATE.restoreConnectedOnly !== false;

    const execBtnText = !isLassoActive
      ? markedCount > 0
        ? `Resume Lasso (${markedCount} selected kept · 繼續套索標記)`
        : "Select with Lasso — Mark for Deletion (啟用套索標記刪除)"
      : markedCount > 0
      ? `🗑️ Delete (${markedCount} region${markedCount === 1 ? "" : "s"} · ${triCountLabel})`
      : "🗑️ Delete (Mark polygons with Lasso first)";

    showSidePanel(
      `<span>Lasso Delete — Mark &amp; Delete (套索標記刪除)</span>`,
      `
      ${
        STATE.multiAlign?.active
          ? `<div style="background:rgba(56,189,248,0.11);border:1px solid rgba(56,189,248,0.4);border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:11px;color:var(--ui-text-primary);display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <span style="flex:1;min-width:140px;">🔗 <b>Multi-Scan Mode:</b> Selected &amp; deleted polygons stay preserved when returning to Alignment.</span>
              <button type="button" class="gs-top-btn" id="btnLassoBackToAlign" style="padding:4px 9px;font-size:11px;font-weight:700;flex-shrink:0;" title="Return to 3D Gizmo Alignment &amp; Layer Checklist (keeps all selected &amp; deleted polygons)">
                <span>🎯 Return to Alignment</span>
              </button>
            </div>`
          : ""
      }
      <div style="background:rgba(239,68,68,0.10);border:1px solid rgba(239,68,68,0.35);border-radius:8px;padding:10px;margin-bottom:10px;">
        <div style="font-size:12px;font-weight:700;color:#ef4444;margin-bottom:5px;display:flex;align-items:center;justify-content:space-between;gap:6px;">
          <span>🗑️ Mark Polygons for Deletion</span>
          ${
            isLassoActive
              ? `<button type="button" class="gs-top-btn" id="btnCancelLassoMode" style="padding:2px 7px;font-size:10.5px;border-color:rgba(239,68,68,0.45);color:#ef4444;" title="Pause Lasso to Orbit Freely — Selected Polygons Stay Preserved (Esc)">
                  <span>✋ Orbit (Esc)</span>
                </button>`
              : `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--ui-bg-surface);color:var(--ui-text-secondary);">Orbit Mode</span>`
          }
        </div>
        <div style="font-size:11px;color:var(--ui-text-secondary);margin-bottom:8px;line-height:1.45;">
          ${
            !isLassoActive
              ? isMobView
                ? `單指旋轉模式 — 可自由拖曳旋轉視角${
                    markedCount > 0 ? ` (已保留 <b>${markedCount}</b> 個標記範圍)` : ""
                  }。點擊下方按鈕繼續套索標記。`
                : `Orbit mode active — rotate freely with <b>Left Mouse</b> or <b>Mouse Wheel</b>${
                    markedCount > 0 ? ` (your <b>${markedCount}</b> selected region${markedCount === 1 ? " is" : "s are"} preserved)` : ""
                  }. Press the button below to resume Lasso.`
              : inputMethod !== "polygon"
              ? isMobView
                ? `<b>1.</b> 單指拖曳畫圈標記刪除範圍（雙指縮放平移 · 點擊上方 <b>🔄 旋轉</b> 切換視角）。<br/><b>2.</b> 點擊上方或下方 <b>🗑️ 執行刪除</b> 套用預覽。`
                : `<b>1.</b> Drag <b>Left Mouse</b> several times to mark multiple regions in red (rotate anytime by pressing <b>Mouse Wheel</b> · <b>Alt+Drag</b> to unmark).<br/><b>2.</b> Press <b>Delete</b> below to remove marked regions from preview · <b>Esc</b> to orbit.`
              : isMobView
              ? `<b>1.</b> 點擊 3+ 頂點並點擊上方 <b>✓ 鎖定</b> 完成多邊形標記（雙指縮放平移）。<br/><b>2.</b> 點擊 <b>🗑️ 執行刪除</b> 套用預覽。`
              : `<b>1.</b> Click 3+ vertices and click red <b>V1</b> (or <b>Enter</b>) to lock Polygon #1, then draw Polygon #2, #3... (<b>Mouse Wheel</b> to rotate).<br/><b>2.</b> Press <b>Delete</b> below to remove marked polygons · <b>Esc</b> to orbit.`
          }
        </div>

        <div style="display:flex;gap:5px;margin-bottom:8px;">
          <button type="button" class="gs-top-btn ${isLassoActive && inputMethod !== "polygon" ? "accent" : ""}" id="btnModeFreehandLasso" style="flex:1;justify-content:center;font-size:11px;">
            <span>✏️ Freehand 3D Lasso</span>
          </button>
          <button type="button" class="gs-top-btn ${isLassoActive && inputMethod === "polygon" ? "accent" : ""}" id="btnModePolygonClick" style="flex:1;justify-content:center;font-size:11px;">
            <span>📐 Plan Polygon</span>
          </button>
        </div>

        ${
          inputMethod !== "polygon"
            ? `<label style="display:flex;align-items:flex-start;gap:7px;font-size:11px;color:var(--ui-text-primary);background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;padding:6px 8px;margin-bottom:8px;cursor:pointer;">
                <input type="checkbox" id="chkLassoVisibleOnly" ${visibleOnlyChecked ? "checked" : ""} style="margin-top:2px;accent-color:var(--ui-accent);" />
                <span>
                  <b>Protect Occluded Background (僅選取可見前景表面)</b><br/>
                  <span style="font-size:10px;color:var(--ui-text-secondary);">Prevents deleting walls, roads, or terrain hidden behind foreground objects.</span>
                </span>
              </label>`
            : ""
        }

        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;padding:6px 8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">
          <span>
            Marked: <b>${markedCount > 0 ? `${markedCount} region${markedCount === 1 ? "" : "s"}` : "None yet"}</b>
            · <b id="lblLassoSelectedTris" style="color:#ef4444;">${triCountLabel}</b>
          </span>
          <div style="display:flex;gap:4px;">
            <button type="button" class="gs-top-btn" id="btnUndoLastMark" style="padding:2px 7px;font-size:10.5px;${
              markedCount > 0 ? "" : "opacity:0.45;pointer-events:none;"
            }" ${markedCount > 0 ? "" : "disabled"} title="Remove the most recently marked polygon/lasso stroke">
              <span>Undo Mark</span>
            </button>
            <button type="button" class="gs-top-btn" id="btnDrawCropPolygon" style="padding:2px 7px;font-size:10.5px;" title="Clear all currently marked red regions">
              <span>Clear</span>
            </button>
          </div>
        </div>

        <div style="display:flex;gap:6px;">
          <button type="button" class="gs-top-btn accent" style="flex:1;justify-content:center;padding:9px 12px;font-weight:700;background:#ef4444;border-color:#dc2626;color:#fff;" id="btnExecuteCrop" title="${
            !isLassoActive
              ? "Activate 3D Lasso Selection (Mark for Deletion)"
              : "Delete all marked regions in 3D preview and stage for Save Edits"
          }">
            <span id="lblExecuteCropBtn">${execBtnText}</span>
          </button>
          ${
            !isLassoActive && markedCount > 0
              ? `<button type="button" class="gs-top-btn" id="btnCommitMarkedWhilePaused" style="justify-content:center;padding:9px 10px;font-weight:700;border-color:#dc2626;color:#ef4444;" title="Delete the ${markedCount} marked region(s) right now">
                  <span>🗑️ Delete (${markedCount})</span>
                </button>`
              : ""
          }
        </div>
      </div>

      ${
        st.deletions.length > 0
          ? `<div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:9px 10px;margin-bottom:8px;">
              <div style="font-size:11.5px;font-weight:700;color:var(--ui-text-primary);display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
                <span>🗑️ Deleted in 3D Preview (${totalStagedDelRegions} region${totalStagedDelRegions === 1 ? "" : "s"})</span>
                <span style="font-size:10.5px;color:#ef4444;">-${totalStagedDelTris.toLocaleString()} tris</span>
              </div>
              <div style="display:flex;gap:6px;">
                <button type="button" class="gs-top-btn" id="btnUndoStagedDelete" style="flex:1;justify-content:center;font-size:11px;">
                  <span>↩️ Undo Last Delete</span>
                </button>
                <button type="button" class="gs-top-btn" id="btnClearAllStagedDeletes" style="flex:1;justify-content:center;font-size:11px;">
                  <span>Restore All Deleted</span>
                </button>
              </div>
            </div>`
          : ""
      }

      ${
        canRestoreFromOriginal
          ? `<div style="background:rgba(16,185,129,0.09);border:1px solid rgba(16,185,129,0.38);border-radius:8px;padding:10px;margin-bottom:10px;">
              <div style="font-size:12px;font-weight:700;color:#10b981;margin-bottom:4px;display:flex;align-items:center;justify-content:space-between;gap:6px;">
                <span>🩹 Restore Accidentally Deleted Area (從原始掃描補回缺口)</span>
              </div>
              <div style="font-size:11px;color:var(--ui-text-secondary);margin-bottom:7px;line-height:1.45;">
                Draw a <b>Freehand 3D Lasso</b> or <b>Plan Polygon</b> over any missing gap above, then click below to splice the missing triangles back from the untouched original scan at full 4K quality.
              </div>
              <label style="display:flex;align-items:flex-start;gap:7px;font-size:11px;color:var(--ui-text-primary);background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;padding:5px 8px;margin-bottom:8px;cursor:pointer;">
                <input type="checkbox" id="chkRestoreConnectedOnly" ${restoreConnChecked ? "checked" : ""} style="margin-top:2px;accent-color:#10b981;" />
                <span>
                  <b>Boundary-connected surface only (排除懸浮碎塊)</b><br/>
                  <span style="font-size:10px;color:var(--ui-text-secondary);">Restores surfaces connected to surrounding road/walls while skipping floating sky/tree debris.</span>
                </span>
              </label>
              <button type="button" class="gs-top-btn" id="btnRestoreDeletedRegion" style="width:100%;justify-content:center;padding:8px 12px;font-weight:700;background:${
                markedCount > 0 ? "#10b981" : "rgba(16,185,129,0.16)"
              };border-color:#059669;color:${markedCount > 0 ? "#fff" : "#10b981"};">
                <span>${
                  !isLassoActive && markedCount === 0
                    ? "🩹 Activate Lasso to Mark Gap for Restore (啟用套索圈選缺口)"
                    : markedCount > 0
                    ? `🩹 Restore Deleted Area (${markedCount} marked region${markedCount === 1 ? "" : "s"} · 補回原始模型)`
                    : "🩹 Restore Deleted Area (Circle missing gap with Lasso first)"
                }</span>
              </button>
              <div id="restoreDeletedRegionStatus" style="margin-top:5px;"></div>
            </div>`
          : ""
      }

      ${renderStagedAdjustmentsCardHtml({ alwaysShow: false })}
      `
    );

    document.getElementById("btnLassoBackToAlign")?.addEventListener("click", () => {
      preserveLassoSelectionBeforeToolSwitch();
      const keptMarks = countMarkedRegionsPending();
      setActiveStudioTool("align_merge");
      openAlignMergeInspector();
      if (keptMarks > 0) {
        showToast(`Returned to Alignment — ${keptMarks} selected polygon region${keptMarks === 1 ? "" : "s"} preserved`);
      }
    });

    document.getElementById("btnCancelLassoMode")?.addEventListener("click", () => {
      cancelLassoToolMode(true, false);
      const keptMarks = countMarkedRegionsPending();
      showToast(
        keptMarks > 0
          ? `Orbit mode (${keptMarks} selected region${keptMarks === 1 ? "" : "s"} preserved) — press Resume Lasso to mark more`
          : "Orbit mode — press the red button on the right to start Lasso again"
      );
    });

    document.getElementById("chkLassoVisibleOnly")?.addEventListener("change", (ev) => {
      STATE.lassoVisibleOnlyDelete = Boolean(ev.target.checked);
      const selTris = rebuildLassoHighlight3D();
      openLassoDeleteInspector({ armLasso: isLassoActive });
      showToast(
        STATE.lassoVisibleOnlyDelete
          ? `Occlusion Protection ON — ${selTris.toLocaleString()} visible foreground triangles marked`
          : `Through-Depth Mode — ${selTris.toLocaleString()} triangles marked across all depths`
      );
    });

    document.getElementById("btnModeFreehandLasso")?.addEventListener("click", () => {
      STATE.lassoInputMethod = "lasso";
      STATE.measurePoints = [];
      STATE.cropPolygonPoints = [];
      setActiveStudioTool("crop_delete");
      rebuildLassoHighlight3D();
      openLassoDeleteInspector({ armLasso: true });
      showToast("Freehand 3D Lasso active — Left-Drag multiple regions, Mouse Wheel to rotate, then press Delete");
    });

    document.getElementById("btnModePolygonClick")?.addEventListener("click", () => {
      STATE.lassoInputMethod = "polygon";
      STATE.measurePoints = [];
      STATE.cropPolygonPoints = [];
      setActiveStudioTool("crop_delete");
      rebuildLassoHighlight3D();
      openLassoDeleteInspector({ armLasso: true });
      showToast("Plan Polygon active — click 3+ vertices & red V1 to mark multiple polygons, then press Delete");
    });

    document.getElementById("btnUndoLastMark")?.addEventListener("click", () => {
      if (Array.isArray(STATE.measurePoints) && STATE.measurePoints.length > 0) {
        STATE.measurePoints = [];
        STATE.cropPolygonPoints = [];
      } else if (STATE.lassoInputMethod === "polygon" && Array.isArray(STATE.pendingCropPolygons) && STATE.pendingCropPolygons.length > 0) {
        STATE.pendingCropPolygons.pop();
      } else if (Array.isArray(STATE.lassoStrokes) && STATE.lassoStrokes.length > 0) {
        STATE.lassoStrokes.pop();
      } else if (Array.isArray(STATE.pendingCropPolygons) && STATE.pendingCropPolygons.length > 0) {
        STATE.pendingCropPolygons.pop();
      }
      rebuildLassoHighlight3D();
      openLassoDeleteInspector({ armLasso: isLassoActive });
      showToast("Removed last marked region");
    });

    document.getElementById("btnDrawCropPolygon")?.addEventListener("click", () => {
      STATE.polygonLocked = false;
      STATE.measurePoints = [];
      clearLassoSelectionState();
      if (isLassoActive) setActiveStudioTool("crop_delete");
      openLassoDeleteInspector({ armLasso: isLassoActive });
      showToast("Cleared marked regions");
    });

    document.getElementById("btnUndoStagedDelete")?.addEventListener("click", () => {
      if (st.deletions.length > 0) {
        st.deletions.pop();
        st.rev++;
        applyStagedEditsToStudioMeshes(true);
        syncStagedEditsDockBadge();
        openLassoDeleteInspector({ armLasso: isLassoActive });
        showToast("Undid last Delete batch in 3D preview");
      }
    });

    document.getElementById("btnClearAllStagedDeletes")?.addEventListener("click", () => {
      st.deletions = [];
      st.rev++;
      applyStagedEditsToStudioMeshes(true);
      syncStagedEditsDockBadge();
      openLassoDeleteInspector({ armLasso: isLassoActive });
      showToast("Restored all deleted regions in 3D preview");
    });

    document.getElementById("btnCommitMarkedWhilePaused")?.addEventListener("click", () => {
      const res = commitPendingLassoMarksToStagedEdits("delete_inside");
      openLassoDeleteInspector({ armLasso: false });
      if (res.committed > 0) {
        showToast(`Deleted ${res.committed} marked region(s) in 3D preview — press Save Edits when ready!`);
      }
    });

    document.getElementById("btnExecuteCrop")?.addEventListener("click", () => {
      if (STATE.activeTool !== "crop_delete") {
        setActiveStudioTool("crop_delete");
        openLassoDeleteInspector({ armLasso: true });
        showToast("Lasso active (Mark for Deletion) — mark multiple regions, then press Delete");
        return;
      }

      const res = commitPendingLassoMarksToStagedEdits("delete_inside");
      if (res.committed === 0) {
        showToast(
          STATE.lassoInputMethod === "polygon"
            ? "Click 3+ polygon vertices on the 3D scan to mark regions first (Mouse Wheel to rotate)"
            : "Drag Left Mouse on the 3D scan to mark 1 or more regions first (Mouse Wheel to rotate)"
        );
        return;
      }

      openLassoDeleteInspector({ armLasso: true });
      showToast(
        `Deleted ${res.committed} marked region${res.committed === 1 ? "" : "s"} in 3D preview — mark more, adjust Compression / CRS, or press Save Edits!`
      );
    });

    document.getElementById("chkRestoreConnectedOnly")?.addEventListener("change", (ev) => {
      STATE.restoreConnectedOnly = Boolean(ev.target.checked);
    });

    document.getElementById("btnRestoreDeletedRegion")?.addEventListener("click", async () => {
      if (STATE.activeTool !== "crop_delete" && countMarkedRegionsPending() === 0) {
        setActiveStudioTool("crop_delete");
        openLassoDeleteInspector({ armLasso: true });
        showToast("Lasso active — circle the missing gap with Left-Drag, then press '🩹 Restore Deleted Area'");
        return;
      }

      const restoreStrokes = (STATE.lassoStrokes || []).map((s) => Object.assign({}, s, { visible_only: false }));
      const rawWorldPolys = [];
      if (Array.isArray(STATE.pendingCropPolygons)) {
        STATE.pendingCropPolygons.forEach((pts) => {
          if (Array.isArray(pts) && pts.length >= 3) rawWorldPolys.push(pts);
        });
      }
      if (Array.isArray(STATE.measurePoints) && STATE.measurePoints.length >= 3) {
        rawWorldPolys.push(STATE.measurePoints);
      }
      const restorePolys = [];
      if (rawWorldPolys.length > 0 && isActiveStudioTilesetEcef()) {
        rawWorldPolys.forEach((pts) => {
          const orthoSt = planPolygonToTopDownFrustumStroke(pts);
          if (orthoSt) restoreStrokes.push(orthoSt);
        });
      } else {
        rawWorldPolys.forEach((pts) => {
          restorePolys.push(
            pts.map((p) => {
              const n = studioWorldToTilesetNative(p);
              return [n[0], n[1]];
            })
          );
        });
      }

      const regionTotal = restoreStrokes.filter((s) => s.op !== "sub").length + restorePolys.length;
      if (regionTotal === 0) {
        showToast("Drag Left Mouse over the missing gap to mark it first, then press '🩹 Restore Deleted Area'");
        return;
      }

      const btnR = document.getElementById("btnRestoreDeletedRegion");
      const statusBox = document.getElementById("restoreDeletedRegionStatus");
      if (btnR) {
        btnR.disabled = true;
        btnR.innerHTML = `<span>⏳ Splicing Missing Geometry from Original 4K Scan...</span>`;
      }
      if (statusBox) {
        statusBox.innerHTML = `<div style="font-size:11px;color:#10b981;">Restoring missing triangles from original source scan...</div>`;
      }

      try {
        const res = await apiPost("/api/optimizer/restore-region", {
          scan_id: STATE.activeScanId,
          frustum_strokes: restoreStrokes,
          native_polygons: restorePolys,
          connected_only: STATE.restoreConnectedOnly !== false,
        });
        STATE.measurePoints = [];
        clearLassoSelectionState();
        if (Array.isArray(res.scans)) {
          STATE.scans = res.scans;
        } else {
          await refreshScansCatalog();
        }
        if (Array.isArray(res.projects)) {
          STATE.projects = res.projects;
        }
        populateProjectScanDropdowns(res.scan?.project_group || STATE.activeProjectGroup, STATE.activeScanId);
        renderMapClusters();
        loadScanIntoStudio(STATE.activeScanId, { preserveCamera: true, bustCache: true });
        openLassoDeleteInspector({ armLasso: false });
        showToast(
          `Restored ${Number(res.restored_triangles || 0).toLocaleString()} triangles from original scan (${res.duration_s}s)!`
        );
      } catch (err) {
        if (btnR) {
          btnR.disabled = false;
          btnR.innerHTML = `<span>🩹 Restore Deleted Area (${regionTotal} marked)</span>`;
        }
        if (statusBox) {
          statusBox.innerHTML = `<div style="font-size:11px;color:#ef4444;">${escapeHtml(err.message)}</div>`;
        }
        showToast(`Restore note: ${err.message}`);
      }
    });

    bindStagedAdjustmentsCardEvents(() => openLassoDeleteInspector({ armLasso: STATE.activeTool === "crop_delete" }));
  }

  function openLassoKeepInspector(opts = {}) {
    const armLasso = opts && opts.armLasso !== undefined ? Boolean(opts.armLasso) : true;
    STATE.cropMode = "keep_inside";
    if (armLasso) {
      if (STATE.activeTool !== "crop") setActiveStudioTool("crop");
    } else if (STATE.activeTool === "crop" || STATE.activeTool === "crop_delete") {
      setActiveStudioTool("orbit");
    }

    const st = ensureStagedEditsForActiveScan();
    const isLassoActive = STATE.activeTool === "crop";
    const inputMethod = STATE.lassoInputMethod || "lasso";
    const markedCount = countMarkedRegionsPending();
    const triCountLabel = `${Number(STATE.lassoSelectedTriCount || 0).toLocaleString()} tris`;
    const isMobKeep = window.innerWidth <= 768;
    if (isMobKeep) {
      if (isLassoActive && markedCount === 0 && !opts.keepExpanded) {
        STATE.sidePanelMinimized = true;
      } else if (!isLassoActive) {
        STATE.sidePanelMinimized = false;
      }
    } else {
      STATE.sidePanelMinimized = false;
    }

    const execBtnText = !isLassoActive
      ? markedCount > 0
        ? `Resume Keep Selection (${markedCount} kept · 繼續框選)`
        : "Select Keep Boundary (啟用框選保留)"
      : markedCount > 0
      ? `✂️ Stage Keep Crop (${markedCount} region${markedCount === 1 ? "" : "s"} · ${triCountLabel})`
      : "✂️ Stage Keep Crop (Mark region to keep first)";

    showSidePanel(
      `<span>Crop Keep — Keep Selected Region (框選保留)</span>`,
      `
      <div style="background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.35);border-radius:8px;padding:10px;margin-bottom:10px;">
        <div style="font-size:12px;font-weight:700;color:#10b981;margin-bottom:5px;display:flex;align-items:center;justify-content:space-between;gap:6px;">
          <span>✂️ Mark Region(s) to Keep</span>
          ${
            isLassoActive
              ? `<button type="button" class="gs-top-btn" id="btnCancelLassoMode" style="padding:2px 7px;font-size:10.5px;" title="Pause Lasso to Orbit (Esc)">✋ Orbit (Esc)</button>`
              : `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--ui-bg-surface);color:var(--ui-text-secondary);">Orbit Mode</span>`
          }
        </div>
        <div style="font-size:11px;color:var(--ui-text-secondary);margin-bottom:8px;line-height:1.45;">
          ${
            isMobKeep
              ? `單指畫圈或點擊多邊形標記欲<b>保留</b>的範圍（範圍外將於儲存時裁切 · 雙指縮放平移 · 點擊上方 <b>🔄 旋轉</b> 切換視角）。`
              : `Mark the boundary you want to <b>keep</b> (everything outside will be cropped out when you press <b>Save Edits</b>). Rotate anytime with <b>Mouse Wheel</b>.`
          }
        </div>

        <div style="display:flex;gap:5px;margin-bottom:8px;">
          <button type="button" class="gs-top-btn ${isLassoActive && inputMethod !== "polygon" ? "accent" : ""}" id="btnModeFreehandLasso" style="flex:1;justify-content:center;font-size:11px;">
            <span>✏️ Freehand 3D Lasso</span>
          </button>
          <button type="button" class="gs-top-btn ${isLassoActive && inputMethod === "polygon" ? "accent" : ""}" id="btnModePolygonClick" style="flex:1;justify-content:center;font-size:11px;">
            <span>📐 Plan Polygon</span>
          </button>
        </div>

        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;padding:6px 8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:6px;">
          <span>
            Marked: <b>${markedCount > 0 ? `${markedCount} region${markedCount === 1 ? "" : "s"}` : "None yet"}</b>
            · <b id="lblLassoSelectedTris" style="color:#10b981;">${triCountLabel}</b>
          </span>
          <button type="button" class="gs-top-btn" id="btnDrawCropPolygon" style="padding:2px 8px;font-size:10.5px;">Clear</button>
        </div>

        <button type="button" class="gs-top-btn accent" style="width:100%;justify-content:center;padding:8px 12px;font-weight:700;" id="btnExecuteCrop">
          <span>${execBtnText}</span>
        </button>
      </div>

      ${renderStagedAdjustmentsCardHtml({ alwaysShow: false })}
      `
    );

    document.getElementById("btnLassoBackToAlign")?.addEventListener("click", () => {
      preserveLassoSelectionBeforeToolSwitch();
      setActiveStudioTool("align_merge");
      openAlignMergeInspector();
    });

    document.getElementById("btnCancelLassoMode")?.addEventListener("click", () => {
      cancelLassoToolMode(true, false);
    });
    document.getElementById("btnModeFreehandLasso")?.addEventListener("click", () => {
      STATE.lassoInputMethod = "lasso";
      STATE.measurePoints = [];
      STATE.cropPolygonPoints = [];
      setActiveStudioTool("crop");
      rebuildLassoHighlight3D();
      openLassoKeepInspector({ armLasso: true });
    });
    document.getElementById("btnModePolygonClick")?.addEventListener("click", () => {
      STATE.lassoInputMethod = "polygon";
      STATE.measurePoints = [];
      STATE.cropPolygonPoints = [];
      setActiveStudioTool("crop");
      rebuildLassoHighlight3D();
      openLassoKeepInspector({ armLasso: true });
    });
    document.getElementById("btnDrawCropPolygon")?.addEventListener("click", () => {
      STATE.measurePoints = [];
      clearLassoSelectionState();
      if (isLassoActive) setActiveStudioTool("crop");
      openLassoKeepInspector({ armLasso: isLassoActive });
    });
    document.getElementById("btnExecuteCrop")?.addEventListener("click", () => {
      if (STATE.activeTool !== "crop") {
        setActiveStudioTool("crop");
        openLassoKeepInspector({ armLasso: true });
        return;
      }
      const res = commitPendingLassoMarksToStagedEdits("keep_inside");
      if (res.committed === 0) {
        showToast("Mark at least 1 region to keep first.");
        return;
      }
      setActiveStudioTool("orbit");
      openLassoKeepInspector({ armLasso: false });
      showToast("Staged Keep Crop in 3D preview — adjust Compression / CRS or press Save Edits!");
    });

    bindStagedAdjustmentsCardEvents(() => openLassoKeepInspector({ armLasso: STATE.activeTool === "crop" }));
  }

  function renderActiveScanSpecsCardHtml(scan = STATE.activeScan) {
    if (!scan) return "";
    updateStudioScanMetricsReadout(scan);
    const polyStr = formatScanPolyCount(scan);
    const texStr = formatScanTextureSize(scan);
    const sizeStr = formatScanSizeMb(scan, { includeTotal: true });
    return `
      <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:10px;margin-bottom:10px;">
        <div style="font-size:11px;font-weight:700;color:var(--ui-text-secondary);margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">
          <span>📊 Active Scan Metrics (目前掃描規格)</span>
          <span style="color:var(--ui-accent);font-family:monospace;">${escapeHtml(formatCoveredAreaM2(scan))}</span>
        </div>
        <div class="gs-metric-grid" style="grid-template-columns:repeat(3,1fr);gap:6px;">
          <div class="gs-metric-box" style="padding:6px 7px;">
            <div class="lbl">Polygon Count</div>
            <div class="val" style="font-size:11.5px;">${escapeHtml(polyStr)}</div>
          </div>
          <div class="gs-metric-box" style="padding:6px 7px;">
            <div class="lbl">Texture Size</div>
            <div class="val" style="font-size:11.5px;">${escapeHtml(texStr)}</div>
          </div>
          <div class="gs-metric-box" style="padding:6px 7px;">
            <div class="lbl">Scan Size (MB)</div>
            <div class="val" style="font-size:11.5px;" title="${escapeHtml(sizeStr)}">${escapeHtml(formatScanSizeMb(scan))}</div>
          </div>
        </div>
      </div>
    `;
  }

  function openMeshCompressionInspector() {
    STATE.sidePanelMinimized = false;
    const st = ensureStagedEditsForActiveScan();
    const curPreset = st.compressionPreset || "balanced";

    showSidePanel(
      `<span>Mesh &amp; Texture Compression (網格壓縮優化)</span>`,
      `
      ${renderActiveScanSpecsCardHtml(STATE.activeScan)}
      <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:11px;margin-bottom:10px;">
        <div style="font-size:12px;font-weight:700;color:var(--ui-text-primary);margin-bottom:4px;">
          ⚡ GC_ScanOptimizer Compression Preset
        </div>
        <p style="font-size:11px;color:var(--ui-text-secondary);margin-bottom:9px;line-height:1.45;">
          Choose mesh decimation &amp; texture optimization to apply when generating your new scan (64-bit coordinate precision preserved).
        </p>
        <div class="gs-form-group" style="margin-bottom:10px;">
          <label>Target Compression Level (壓縮與串流等級)</label>
          <select class="gs-select" id="optPresetSelect">
            <option value="none" ${curPreset === "none" ? "selected" : ""}>No Extra Compression (100% Original Mesh &amp; Textures)</option>
            <option value="quality" ${curPreset === "quality" ? "selected" : ""}>High Fidelity Quality (75% Tris · 2048px JPEG)</option>
            <option value="balanced" ${curPreset === "balanced" ? "selected" : ""}>Balanced Web Stream (50% Tris · 1536px JPEG)</option>
            <option value="web" ${curPreset === "web" ? "selected" : ""}>Fast Field Tablet (35% Tris · 1024px JPEG)</option>
            <option value="ultra_light" ${curPreset === "ultra_light" ? "selected" : ""}>Ultra-Light Offline Cache (20% Tris · 768px JPEG)</option>
          </select>
        </div>
        <button type="button" class="gs-top-btn accent" style="width:100%;justify-content:center;padding:8px 12px;font-weight:700;" id="btnStageCompression">
          <span>⚡ Stage Compression Adjustment (加入壓縮設定)</span>
        </button>
      </div>

      ${renderStagedAdjustmentsCardHtml({ alwaysShow: true })}
      `
    );

    document.getElementById("btnStageCompression")?.addEventListener("click", () => {
      const chosen = document.getElementById("optPresetSelect")?.value || "balanced";
      if (chosen === "none") {
        st.compressionPreset = null;
        showToast("Cleared extra mesh compression (100% original resolution will be kept)");
      } else {
        st.compressionPreset = chosen;
        showToast(`Staged Compression: ${COMPRESSION_PRESET_LABELS[chosen] || chosen}`);
      }
      syncStagedEditsDockBadge();
      openMeshCompressionInspector();
    });

    bindStagedAdjustmentsCardEvents(() => openMeshCompressionInspector());
  }

  function openCoordinateSystemInspector() {
    STATE.sidePanelMinimized = false;
    const st = ensureStagedEditsForActiveScan();
    const rc = STATE.multiAlign?.active ? STATE.multiAlign?.refCenter : null;
    const scan = rc
      ? Object.assign({}, STATE.activeScan || {}, {
          twd97_e: Number(rc.x || 0),
          twd97_n: Number(rc.y || 0),
          twd97_h: Number(rc.z || 0),
          crs: "TWD97 (121) + TWVD2001",
        })
      : STATE.activeScan || {};
    const curCode = inferActiveScanCrsCode(scan);
    const selectedCode = st.crsConfig?.target_crs || curCode;
    const initOffX = Number(st.crsConfig?.offset_x || 0);
    const initOffY = Number(st.crsConfig?.offset_y || 0);
    const initOffZ = Number(st.crsConfig?.offset_z || 0);

    const curE = scan.twd97_e !== undefined && scan.twd97_e !== null ? Number(scan.twd97_e) : 0;
    const curN = scan.twd97_n !== undefined && scan.twd97_n !== null ? Number(scan.twd97_n) : 0;
    const curH = scan.twd97_h !== undefined && scan.twd97_h !== null ? Number(scan.twd97_h) : 0;

    showSidePanel(
      `<span>Coordinate System &amp; Datum (座標系統轉換)</span>`,
      `
      <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:11px;margin-bottom:10px;">
        <div style="font-size:12px;font-weight:700;color:var(--ui-text-primary);margin-bottom:4px;">
          🌐 Coordinate Reference System (CRS)
        </div>
        <div style="font-size:11px;color:var(--ui-text-secondary);background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;padding:7px 8px;margin-bottom:9px;line-height:1.45;">
          <div><b>Current Scan CRS:</b> ${escapeHtml(scan.crs || "TWD97 (121) + TWVD2001")}</div>
          <div><b>Current Center:</b> X/E ${curE.toFixed(3)}m · Y/N ${curN.toFixed(3)}m · Z/H ${curH.toFixed(2)}m</div>
        </div>

        <div class="gs-form-group" style="margin-bottom:8px;">
          <label>Target Coordinate System (目標座標系統)</label>
          <select class="gs-select" id="selTargetCrs">
            ${CRS_UI_CATALOG.map(
              (c) => `<option value="${c.code}" ${c.code === selectedCode ? "selected" : ""}>${escapeHtml(c.fullLabel)}</option>`
            ).join("")}
          </select>
        </div>

        <div class="gs-form-group" style="margin-bottom:8px;">
          <label>Optional Custom Datum Offset ΔX / ΔY / ΔZ (自訂平移量, m)</label>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
            <input type="number" step="0.001" class="gs-input" id="numCrsOffsetX" value="${initOffX}" title="ΔX / ΔEasting (m)" placeholder="ΔX (m)" />
            <input type="number" step="0.001" class="gs-input" id="numCrsOffsetY" value="${initOffY}" title="ΔY / ΔNorthing (m)" placeholder="ΔY (m)" />
            <input type="number" step="0.001" class="gs-input" id="numCrsOffsetZ" value="${initOffZ}" title="ΔZ / ΔElevation (m)" placeholder="ΔZ (m)" />
          </div>
        </div>

        <div id="lblCrsTargetPreview" style="font-size:11px;color:var(--ui-accent);background:var(--ui-bg-surface);border:1px solid var(--ui-border);border-radius:6px;padding:7px 8px;margin-bottom:9px;"></div>

        <button type="button" class="gs-top-btn accent" style="width:100%;justify-content:center;padding:8px 12px;font-weight:700;" id="btnStageCrs">
          <span>🌐 Stage Coordinate System (加入座標系統設定)</span>
        </button>
      </div>

      ${renderStagedAdjustmentsCardHtml({ alwaysShow: true })}
      `
    );

    const updatePreviewBox = () => {
      const code = document.getElementById("selTargetCrs")?.value || curCode;
      const ox = Number(document.getElementById("numCrsOffsetX")?.value || 0);
      const oy = Number(document.getElementById("numCrsOffsetY")?.value || 0);
      const oz = Number(document.getElementById("numCrsOffsetZ")?.value || 0);
      const prev = previewTargetCrsCenterJS(scan, code, ox, oy, oz);
      const previewEl = document.getElementById("lblCrsTargetPreview");
      const stageBtn = document.getElementById("btnStageCrs");
      if (prev.error) {
        if (previewEl) {
          previewEl.innerHTML = `<span style="color:#f59e0b;font-weight:700;">⚠️ ${escapeHtml(prev.error)}</span>`;
        }
        if (stageBtn) stageBtn.disabled = true;
        return;
      }
      if (stageBtn) stageBtn.disabled = false;
      if (previewEl) {
        previewEl.innerHTML = `<b>New Scan Center (${escapeHtml(prev.crsLabel)}):</b><br/>X/E <b>${prev.x.toFixed(
          3
        )}m</b> · Y/N <b>${prev.y.toFixed(3)}m</b> · Z/H <b>${prev.z.toFixed(2)}m</b>`;
      }
    };
    updatePreviewBox();

    ["selTargetCrs", "numCrsOffsetX", "numCrsOffsetY", "numCrsOffsetZ"].forEach((id) => {
      document.getElementById(id)?.addEventListener("input", updatePreviewBox);
      document.getElementById(id)?.addEventListener("change", updatePreviewBox);
    });

    document.getElementById("btnStageCrs")?.addEventListener("click", () => {
      const code = document.getElementById("selTargetCrs")?.value || curCode;
      const ox = Number(document.getElementById("numCrsOffsetX")?.value || 0);
      const oy = Number(document.getElementById("numCrsOffsetY")?.value || 0);
      const oz = Number(document.getElementById("numCrsOffsetZ")?.value || 0);
      const prev = previewTargetCrsCenterJS(scan, code, ox, oy, oz);
      if (prev.error) {
        showToast(prev.error);
        return;
      }
      st.crsConfig = {
        target_crs: code,
        offset_x: ox,
        offset_y: oy,
        offset_z: oz,
      };
      syncStagedEditsDockBadge();
      const item = CRS_UI_CATALOG.find((c) => c.code === code);
      openCoordinateSystemInspector();
      showToast(`Staged Coordinate System: ${item ? item.shortLabel : code}`);
    });

    bindStagedAdjustmentsCardEvents(() => openCoordinateSystemInspector());
  }

  function openGenerateScanInspector() {
    STATE.sidePanelMinimized = false;
    showSidePanel(
      `<span>Save Scan Edits (儲存掃描變更)</span>`,
      `
      ${renderActiveScanSpecsCardHtml(STATE.activeScan)}
      <div style="font-size:11.5px;color:var(--ui-text-secondary);line-height:1.45;margin-bottom:6px;">
        Combine multiple <b>Lasso Deletions</b>, <b>Mesh Compression</b>, and <b>Coordinate System</b> changes, then press <b>Save Edits</b> once — your edited scan is saved and a backup of <b>${escapeHtml(
          STATE.activeScan?.name || STATE.activeScanId || "the original scan"
        )}</b> is moved to the <b>Trash Bin</b> (restorable anytime).
      </div>
      ${renderStagedAdjustmentsCardHtml({ alwaysShow: true })}
      `
    );
    bindStagedAdjustmentsCardEvents(() => openGenerateScanInspector());
  }

  function openOptimizerInspector(preferredCropMode = null, opts = {}) {
    if (preferredCropMode === "keep_inside") {
      openLassoKeepInspector(opts);
    } else {
      openLassoDeleteInspector(opts);
    }
  }

  // =========================================================================
  // MULTI-SCAN 3D ALIGNMENT & MERGE ENGINE (Move + Rotate Gizmos + Lock + Merge)
  // =========================================================================
  const MULTI_ALIGN_PALETTE = [
    "#38bdf8", // Layer 1 Sky Blue
    "#f59e0b", // Layer 2 Amber
    "#10b981", // Layer 3 Emerald
    "#ec4899", // Layer 4 Pink
    "#a855f7", // Layer 5 Purple
    "#eab308", // Layer 6 Yellow
  ];

  const _gizmoDrag = {
    active: false,
    handleType: null, // 'tx' | 'ty' | 'tz' | 'txz' | 'rx' | 'ry' | 'rz'
    hoveredHandle: null,
    layer: null,
    startTx: 0,
    startTy: 0,
    startTz: 0,
    startRx: 0,
    startRy: 0,
    startRz: 0,
    originWorld: new THREE.Vector3(),
    axisWorld: new THREE.Vector3(),
    dragPlane: new THREE.Plane(),
    startHitPt: new THREE.Vector3(),
    startAngle: 0,
  };

  function buildStudioTransformGizmo(ctx) {
    if (!ctx || !ctx.gizmoGroup) return;
    while (ctx.gizmoGroup.children.length > 0) {
      ctx.gizmoGroup.remove(ctx.gizmoGroup.children[0]);
    }
    const handles = [];

    const makeMat = (hex, opacity = 0.95) =>
      new THREE.MeshBasicMaterial({
        color: hex,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
      });

    const makeHitMat = () =>
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.001,
        side: THREE.DoubleSide,
      });

    // Helper to build a translation arrow along +X, +Y, or +Z
    const addAxisArrow = (axisKey, hexColor, dirVec) => {
      const grp = new THREE.Group();
      grp.userData.gizmoModeGroup = "translate";
      const visMat = makeMat(hexColor, 0.96);

      const shaftGeo = new THREE.CylinderGeometry(0.032, 0.032, 0.82, 14);
      shaftGeo.translate(0, 0.41, 0);
      const shaft = new THREE.Mesh(shaftGeo, visMat);
      shaft.renderOrder = 2500;

      const coneGeo = new THREE.ConeGeometry(0.095, 0.24, 18);
      coneGeo.translate(0, 0.92, 0);
      const cone = new THREE.Mesh(coneGeo, visMat);
      cone.renderOrder = 2501;

      const hitGeo = new THREE.CylinderGeometry(0.13, 0.13, 1.08, 12);
      hitGeo.translate(0, 0.54, 0);
      const hitMesh = new THREE.Mesh(hitGeo, makeHitMat());
      hitMesh.renderOrder = 2502;
      hitMesh.userData.gizmoHandle = axisKey;
      hitMesh.userData.visualMat = visMat;
      hitMesh.userData.baseHex = hexColor;

      grp.add(shaft, cone, hitMesh);
      if (axisKey === "tx") grp.rotation.z = -Math.PI / 2;
      else if (axisKey === "tz") grp.rotation.x = Math.PI / 2;
      ctx.gizmoGroup.add(grp);
      handles.push(hitMesh);
    };

    addAxisArrow("tx", 0xef4444, new THREE.Vector3(1, 0, 0)); // +X East (Red)
    addAxisArrow("ty", 0x22c55e, new THREE.Vector3(0, 1, 0)); // +Y Up/Elev (Green)
    addAxisArrow("tz", 0x3b82f6, new THREE.Vector3(0, 0, 1)); // +Z South/North (Blue)

    // XZ Horizontal Ground Plane Slider Handle (Amber Quad)
    const xzGrp = new THREE.Group();
    xzGrp.userData.gizmoModeGroup = "translate";
    const xzVisMat = makeMat(0xf59e0b, 0.55);
    const xzGeo = new THREE.PlaneGeometry(0.28, 0.28);
    xzGeo.rotateX(-Math.PI / 2);
    xzGeo.translate(0.28, 0.01, 0.28);
    const xzQuad = new THREE.Mesh(xzGeo, xzVisMat);
    xzQuad.renderOrder = 2499;
    xzQuad.userData.gizmoHandle = "txz";
    xzQuad.userData.visualMat = xzVisMat;
    xzQuad.userData.baseHex = 0xf59e0b;
    xzGrp.add(xzQuad);
    ctx.gizmoGroup.add(xzGrp);
    handles.push(xzQuad);

    // Helper to build a 3D rotation torus ring around Y (Yaw), X (Pitch), Z (Roll)
    const addRotationRing = (handleKey, hexColor, rotX, rotY, radius = 1.15) => {
      const grp = new THREE.Group();
      grp.userData.gizmoModeGroup = "rotate";
      const visMat = makeMat(hexColor, 0.9);
      const torusGeo = new THREE.TorusGeometry(radius, 0.024, 14, 64);
      const torus = new THREE.Mesh(torusGeo, visMat);
      torus.rotation.set(rotX, rotY, 0);
      torus.renderOrder = 2500;

      const hitTorusGeo = new THREE.TorusGeometry(radius, 0.11, 10, 48);
      const hitTorus = new THREE.Mesh(hitTorusGeo, makeHitMat());
      hitTorus.rotation.set(rotX, rotY, 0);
      hitTorus.renderOrder = 2502;
      hitTorus.userData.gizmoHandle = handleKey;
      hitTorus.userData.visualMat = visMat;
      hitTorus.userData.baseHex = hexColor;

      grp.add(torus, hitTorus);
      ctx.gizmoGroup.add(grp);
      handles.push(hitTorus);
    };

    // RY (Yaw around vertical Y axis - Horizontal XZ ring, Emerald/Cyan)
    addRotationRing("ry", 0x10b981, Math.PI / 2, 0, 1.22);
    // RX (Pitch around X axis - YZ ring, Coral Red)
    addRotationRing("rx", 0xf87171, 0, Math.PI / 2, 1.08);
    // RZ (Roll around Z axis - XY ring, Sky Blue)
    addRotationRing("rz", 0x60a5fa, 0, 0, 1.15);

    // Center pivot sphere
    const centerMat = makeMat(0xffffff, 0.95);
    const centerSphere = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 16), centerMat);
    centerSphere.renderOrder = 2505;
    ctx.gizmoGroup.add(centerSphere);
    ctx.gizmoGroup.userData.handles = handles;
    ctx.gizmoGroup.userData.centerMat = centerMat;
  }

  function getSelectedMultiAlignLayer() {
    if (!STATE.multiAlign.active || !STATE.multiAlign.layers.length) return null;
    return (
      STATE.multiAlign.layers.find((l) => l.scan_id === STATE.multiAlign.selectedScanId) ||
      STATE.multiAlign.layers[0]
    );
  }

  function updateStudioTransformGizmo() {
    if (!studioThree || !studioThree.gizmoGroup) return;
    const layer = getSelectedMultiAlignLayer();
    const shouldShow = Boolean(
      STATE.multiAlign.active &&
        STATE.activeTool === "align_merge" &&
        layer &&
        layer.visible &&
        layer.layerGroup
    );
    studioThree.gizmoGroup.visible = shouldShow;
    if (!shouldShow) return;

    studioThree.gizmoGroup.position.copy(layer.layerGroup.position);
    const dist = Math.max(2.0, studioThree.camera.position.distanceTo(studioThree.gizmoGroup.position));
    const scale = dist * 0.16;
    studioThree.gizmoGroup.scale.setScalar(scale);

    const mode = STATE.multiAlign.gizmoMode || "both";
    studioThree.gizmoGroup.children.forEach((child) => {
      const mGrp = child.userData?.gizmoModeGroup;
      if (mGrp === "translate") {
        child.visible = mode === "both" || mode === "translate";
      } else if (mGrp === "rotate") {
        child.visible = mode === "both" || mode === "rotate";
      }
    });

    if (studioThree.gizmoGroup.userData.centerMat) {
      studioThree.gizmoGroup.userData.centerMat.color.setHex(layer.locked ? 0xf59e0b : 0xffffff);
    }

    // Highlight active layer bounding box
    STATE.multiAlign.layers.forEach((l) => {
      if (l.boxHelper) {
        l.boxHelper.visible = l.visible && l.scan_id === layer.scan_id;
      }
    });
  }

  function pickGizmoHandle(clientX, clientY) {
    if (!studioThree || !studioThree.gizmoGroup || !studioThree.gizmoGroup.visible) return null;
    const rect = studioThree.renderer.domElement.getBoundingClientRect();
    studioThree.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    studioThree.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    studioThree.raycaster.setFromCamera(studioThree.mouse, studioThree.camera);

    const activeHandles = (studioThree.gizmoGroup.userData.handles || []).filter(
      (h) => h.parent && h.parent.visible
    );
    const hits = studioThree.raycaster.intersectObjects(activeHandles, false);
    return hits.length > 0 ? hits[0].object : null;
  }

  function handleGizmoPointerDown(e) {
    if (e.button !== 0) return false;
    const hitObj = pickGizmoHandle(e.clientX, e.clientY);
    if (!hitObj) return false;

    const layer = getSelectedMultiAlignLayer();
    if (!layer) return false;
    if (layer.locked) {
      showToast(`"${layer.name}" is locked 🔒 — click Unlock before moving or rotating.`);
      return true;
    }

    const handleType = hitObj.userData.gizmoHandle;
    _gizmoDrag.active = true;
    _gizmoDrag.handleType = handleType;
    _gizmoDrag.layer = layer;
    _gizmoDrag.startTx = layer.tx;
    _gizmoDrag.startTy = layer.ty;
    _gizmoDrag.startTz = layer.tz;
    _gizmoDrag.startRx = layer.rx_deg;
    _gizmoDrag.startRy = layer.ry_deg;
    _gizmoDrag.startRz = layer.rz_deg;
    _gizmoDrag.originWorld.copy(layer.layerGroup.position);

    const camDir = new THREE.Vector3();
    studioThree.camera.getWorldDirection(camDir);

    if (handleType === "tx" || handleType === "ty" || handleType === "tz") {
      const axis =
        handleType === "tx"
          ? new THREE.Vector3(1, 0, 0)
          : handleType === "ty"
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1);
      _gizmoDrag.axisWorld.copy(axis);
      // Plane containing the translation axis and facing the camera as closely as possible
      const ortho = new THREE.Vector3().crossVectors(axis, camDir);
      let planeNormal = new THREE.Vector3().crossVectors(ortho, axis).normalize();
      if (planeNormal.lengthSq() < 1e-4) {
        planeNormal.copy(camDir).negate();
      }
      _gizmoDrag.dragPlane.setFromNormalAndCoplanarPoint(planeNormal, _gizmoDrag.originWorld);
      studioThree.raycaster.ray.intersectPlane(_gizmoDrag.dragPlane, _gizmoDrag.startHitPt);
    } else if (handleType === "txz") {
      _gizmoDrag.dragPlane.setFromNormalAndCoplanarPoint(
        new THREE.Vector3(0, 1, 0),
        _gizmoDrag.originWorld
      );
      studioThree.raycaster.ray.intersectPlane(_gizmoDrag.dragPlane, _gizmoDrag.startHitPt);
    } else if (handleType === "rx" || handleType === "ry" || handleType === "rz") {
      const axis =
        handleType === "rx"
          ? new THREE.Vector3(1, 0, 0)
          : handleType === "ry"
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1);
      _gizmoDrag.axisWorld.copy(axis);
      _gizmoDrag.dragPlane.setFromNormalAndCoplanarPoint(axis, _gizmoDrag.originWorld);
      if (studioThree.raycaster.ray.intersectPlane(_gizmoDrag.dragPlane, _gizmoDrag.startHitPt)) {
        const rel = _gizmoDrag.startHitPt.clone().sub(_gizmoDrag.originWorld);
        if (handleType === "ry") _gizmoDrag.startAngle = Math.atan2(rel.x, rel.z);
        else if (handleType === "rx") _gizmoDrag.startAngle = Math.atan2(rel.z, rel.y);
        else _gizmoDrag.startAngle = Math.atan2(rel.y, rel.x);
      }
    }

    studioThree.controls.enabled = false;
    studioThree.renderer.domElement.style.cursor = "grabbing";
    return true;
  }

  function handleGizmoPointerMove(e) {
    if (!studioThree) return false;
    if (!_gizmoDrag.active) {
      const hitObj = pickGizmoHandle(e.clientX, e.clientY);
      if (_gizmoDrag.hoveredHandle && _gizmoDrag.hoveredHandle !== hitObj) {
        const prevMat = _gizmoDrag.hoveredHandle.userData.visualMat;
        if (prevMat) prevMat.color.setHex(_gizmoDrag.hoveredHandle.userData.baseHex);
      }
      _gizmoDrag.hoveredHandle = hitObj;
      if (hitObj) {
        const layer = getSelectedMultiAlignLayer();
        if (layer?.locked) {
          studioThree.renderer.domElement.style.cursor = "not-allowed";
        } else {
          if (hitObj.userData.visualMat) hitObj.userData.visualMat.color.setHex(0xffffff);
          studioThree.renderer.domElement.style.cursor = "grab";
        }
      } else {
        studioThree.renderer.domElement.style.cursor = "";
      }
      return false;
    }

    const rect = studioThree.renderer.domElement.getBoundingClientRect();
    studioThree.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    studioThree.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    studioThree.raycaster.setFromCamera(studioThree.mouse, studioThree.camera);

    const curHit = new THREE.Vector3();
    if (!studioThree.raycaster.ray.intersectPlane(_gizmoDrag.dragPlane, curHit)) return true;

    const layer = _gizmoDrag.layer;
    if (!layer || layer.locked) return true;
    const h = _gizmoDrag.handleType;
    const snapPos = e.shiftKey ? 0.25 : STATE.snapEnabled ? 0.05 : 0.01;
    const snapDeg = e.shiftKey ? 5.0 : STATE.snapEnabled ? 0.5 : 0.1;

    if (h === "tx" || h === "ty" || h === "tz") {
      const deltaVec = curHit.clone().sub(_gizmoDrag.startHitPt);
      const deltaScalar = deltaVec.dot(_gizmoDrag.axisWorld);
      const q = Math.round(deltaScalar / snapPos) * snapPos;
      if (h === "tx") layer.tx = Number((_gizmoDrag.startTx + q).toFixed(2));
      else if (h === "ty") layer.ty = Number((_gizmoDrag.startTy + q).toFixed(2));
      else if (h === "tz") layer.tz = Number((_gizmoDrag.startTz + q).toFixed(2));
    } else if (h === "txz") {
      const deltaVec = curHit.clone().sub(_gizmoDrag.startHitPt);
      const qx = Math.round(deltaVec.x / snapPos) * snapPos;
      const qz = Math.round(deltaVec.z / snapPos) * snapPos;
      layer.tx = Number((_gizmoDrag.startTx + qx).toFixed(2));
      layer.tz = Number((_gizmoDrag.startTz + qz).toFixed(2));
    } else if (h === "rx" || h === "ry" || h === "rz") {
      const rel = curHit.clone().sub(_gizmoDrag.originWorld);
      let curAngle = 0;
      if (h === "ry") curAngle = Math.atan2(rel.x, rel.z);
      else if (h === "rx") curAngle = Math.atan2(rel.z, rel.y);
      else curAngle = Math.atan2(rel.y, rel.x);

      let diffRad = curAngle - _gizmoDrag.startAngle;
      while (diffRad > Math.PI) diffRad -= Math.PI * 2;
      while (diffRad < -Math.PI) diffRad += Math.PI * 2;
      const diffDeg = THREE.MathUtils.radToDeg(diffRad);
      const qDeg = Math.round(diffDeg / snapDeg) * snapDeg;

      const normDeg = (d) => {
        let v = ((d + 180) % 360 + 360) % 360 - 180;
        return Number(v.toFixed(1));
      };
      if (h === "ry") layer.ry_deg = normDeg(_gizmoDrag.startRy + qDeg);
      else if (h === "rx") layer.rx_deg = normDeg(_gizmoDrag.startRx - qDeg);
      else if (h === "rz") layer.rz_deg = normDeg(_gizmoDrag.startRz + qDeg);
    }

    layer._userMoved = true;
    applyLayerTransformTo3D(layer);
    syncAlignLayerInputsInDOM(layer);
    return true;
  }

  function handleGizmoPointerUp() {
    if (!_gizmoDrag.active) return false;
    _gizmoDrag.active = false;
    _gizmoDrag.handleType = null;
    if (studioThree) {
      studioThree.controls.enabled = true;
      studioThree.renderer.domElement.style.cursor = "";
      if (countMarkedRegionsPending() > 0) {
        rebuildLassoHighlight3D();
      }
    }
    return true;
  }

  function handleMultiAlignCanvasClick(e) {
    if (!studioThree || !STATE.multiAlign.active || STATE.activeTool !== "align_merge") return false;
    if (pickGizmoHandle(e.clientX, e.clientY)) return true;

    const rect = studioThree.renderer.domElement.getBoundingClientRect();
    studioThree.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    studioThree.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    studioThree.raycaster.setFromCamera(studioThree.mouse, studioThree.camera);

    const meshTargets = [];
    STATE.multiAlign.layers.forEach((layer) => {
      if (!layer.visible || !layer.layerGroup) return;
      layer.layerGroup.traverse((c) => {
        if (c.isMesh && c.visible && !c.userData?.isAlignBoxHelper) {
          c.userData._alignScanId = layer.scan_id;
          meshTargets.push(c);
        }
      });
    });

    const hits = studioThree.raycaster.intersectObjects(meshTargets, false);
    if (hits.length > 0) {
      const hitScanId = hits[0].object.userData?._alignScanId;
      if (hitScanId && hitScanId !== STATE.multiAlign.selectedScanId) {
        STATE.multiAlign.selectedScanId = hitScanId;
        updateStudioTransformGizmo();
        renderAlignMergeInspectorContent();
        const picked = STATE.multiAlign.layers.find((l) => l.scan_id === hitScanId);
        if (picked) showToast(`Selected "${picked.name}" for 3D Gizmo alignment`);
        return true;
      }
    }
    return false;
  }

  function applyLayerTransformTo3D(layer) {
    if (!layer || !layer.layerGroup) return;
    layer.layerGroup.position.set(
      Number(layer.tx) || 0,
      Number(layer.ty) || 0,
      Number(layer.tz) || 0
    );
    layer.layerGroup.rotation.set(
      THREE.MathUtils.degToRad(Number(layer.rx_deg) || 0),
      THREE.MathUtils.degToRad(Number(layer.ry_deg) || 0),
      THREE.MathUtils.degToRad(Number(layer.rz_deg) || 0),
      "XYZ"
    );
    layer.layerGroup.updateMatrixWorld(true);
    updateStudioTransformGizmo();
    if (!_gizmoDrag.active && studioThree && countMarkedRegionsPending() > 0) {
      if (studioThree._lassoRebuildTimer) clearTimeout(studioThree._lassoRebuildTimer);
      studioThree._lassoRebuildTimer = setTimeout(() => {
        rebuildLassoHighlight3D();
      }, 60);
    }
  }

  function syncAlignLayerInputsInDOM(layer) {
    if (!layer) return;
    const fields = ["tx", "ty", "tz", "rx_deg", "ry_deg", "rz_deg"];
    fields.forEach((f) => {
      const inp = document.querySelector(
        `.align-num-input[data-scan-id="${layer.scan_id}"][data-field="${f}"]`
      );
      if (inp && document.activeElement !== inp) {
        inp.value = f.endsWith("_deg") ? Number(layer[f] || 0).toFixed(1) : Number(layer[f] || 0).toFixed(2);
      }
    });
    const lbl = document.getElementById("lblLastPickedCoord");
    if (lbl) {
      lbl.textContent = `ALIGN [${layer.name}]: ΔX=${layer.tx.toFixed(2)}m, ΔY=${layer.ty.toFixed(2)}m, ΔZ=${layer.tz.toFixed(2)}m | Yaw=${layer.ry_deg.toFixed(1)}°, Pitch=${layer.rx_deg.toFixed(1)}°, Roll=${layer.rz_deg.toFixed(1)}°`;
    }
  }

  function updateMultiAlignLayersEachFrame() {
    if (!studioThree || !STATE.multiAlign.active) return;
    const showAlignBoxes = STATE.activeTool === "align_merge";
    STATE.multiAlign.layers.forEach((layer) => {
      if (layer.boxHelper) {
        layer.boxHelper.visible = Boolean(layer.visible && showAlignBoxes);
      }
      if (!layer.visible) return;
      if (layer.tilesRenderer) {
        layer.tilesRenderer.update();
        const tintKey = `${STATE.scanBrightness}_${layer.tintEnabled ? layer.color : "none"}`;
        layer.tilesRenderer.group.traverse((child) => {
          if (child.isMesh && child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => {
              if (!m) return;
              if (m.metalness > 0) {
                m.metalness = 0.0;
                m.roughness = 1.0;
                m.side = THREE.DoubleSide;
                m.needsUpdate = true;
              }
              if (m.userData?._lastAlignTint !== tintKey) {
                applyBrightnessToMaterial(m, STATE.scanBrightness);
                if (layer.tintEnabled && m.color) {
                  const tintCol = new THREE.Color(layer.color);
                  m.color.lerp(tintCol, 0.35);
                }
                m.userData._lastAlignTint = tintKey;
              }
            });
          }
        });
      }
    });
  }

  function addScanLayerToMultiAlign(scanId, options = {}) {
    initStudio3D();
    const scan = STATE.scans.find((s) => s.scan_id === scanId);
    if (!scan || !studioThree) return null;

    const existing = STATE.multiAlign.layers.find((l) => l.scan_id === scanId);
    if (existing) {
      STATE.multiAlign.selectedScanId = existing.scan_id;
      updateStudioTransformGizmo();
      return existing;
    }

    const idx = STATE.multiAlign.layers.length;
    const color = MULTI_ALIGN_PALETTE[idx % MULTI_ALIGN_PALETTE.length];

    const layerGroup = new THREE.Group();
    const zUpGroup = new THREE.Group();
    zUpGroup.rotation.set(THREE.MathUtils.degToRad(270), 0, 0);
    layerGroup.add(zUpGroup);
    studioThree.multiAlignGroup.add(layerGroup);

    const layer = {
      scan_id: scan.scan_id,
      name: scan.name,
      project_group: scan.project_group || "Unassigned Site",
      color,
      visible: true,
      locked: false,
      tintEnabled: Boolean(options.tintEnabled),
      tx: Number(options.tx) || 0,
      ty: Number(options.ty) || 0,
      tz: Number(options.tz) || 0,
      rx_deg: Number(options.rx_deg) || 0,
      ry_deg: Number(options.ry_deg) || 0,
      rz_deg: Number(options.rz_deg) || 0,
      _userMoved: Boolean(options.userMoved),
      layerGroup,
      zUpGroup,
      tilesRenderer: null,
      rawCenter: null,
      boxHelper: null,
      ready: false,
    };

    STATE.multiAlign.layers.push(layer);
    STATE.multiAlign.selectedScanId = layer.scan_id;

    const syncLayerRelativeOffset = (targetLayer) => {
      if (!targetLayer || !targetLayer.rawCenter || targetLayer._userMoved || !STATE.multiAlign.refCenter) return;
      if (STATE.multiAlign.layers[0]?.scan_id === targetLayer.scan_id) return;
      const ref = STATE.multiAlign.refCenter;
      const dx = targetLayer.rawCenter.x - ref.x;
      const dy = targetLayer.rawCenter.z - ref.z;
      const dz = -(targetLayer.rawCenter.y - ref.y);
      const dist3D = Math.hypot(dx, dy, dz);
      if (dist3D > 0.3 && dist3D < 400) {
        targetLayer.tx = Number(dx.toFixed(2));
        targetLayer.ty = Number(dy.toFixed(2));
        targetLayer.tz = Number(dz.toFixed(2));
      } else if (dist3D >= 400) {
        const myIdx = STATE.multiAlign.layers.indexOf(targetLayer);
        targetLayer.tx = Number((Math.max(1, myIdx) * 14).toFixed(2));
        targetLayer.ty = 0;
        targetLayer.tz = 0;
      } else {
        targetLayer.tx = 0;
        targetLayer.ty = 0;
        targetLayer.tz = 0;
      }
      applyLayerTransformTo3D(targetLayer);
      syncAlignLayerInputsInDOM(targetLayer);
    };

    const finalizeLoadedMultiAlignLayer = (sphere) => {
      layer.rawCenter = { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z };
      layer._sphereRadius = sphere.radius || 38;
      layer.ready = true;

      if (STATE.multiAlign.layers[0]?.scan_id === layer.scan_id || !STATE.multiAlign.refCenter) {
        STATE.multiAlign.refCenter = { ...layer.rawCenter };
        STATE.multiAlign.layers.forEach((other) => {
          if (other !== layer && other.ready) syncLayerRelativeOffset(other);
        });
      } else {
        syncLayerRelativeOffset(layer);
      }

      if (!layer.boxHelper) {
        const r = Math.max(4, Math.min(45, (sphere.radius || 20) * 0.45));
        const boxGeo = new THREE.BoxGeometry(r * 1.4, r * 0.55, r * 1.4);
        const edges = new THREE.EdgesGeometry(boxGeo);
        const lineMat = new THREE.LineBasicMaterial({
          color: new THREE.Color(layer.color),
          transparent: true,
          opacity: 0.75,
        });
        const boxHelper = new THREE.LineSegments(edges, lineMat);
        boxHelper.userData.isAlignBoxHelper = true;
        layerGroup.add(boxHelper);
        layer.boxHelper = boxHelper;
      }

      applyLayerTransformTo3D(layer);
      syncAlignLayerInputsInDOM(layer);
    };

    const streamUrl = scan.stream_url || `/stream/${scan.scan_id}/tileset.json`;
    const isGlbStream = scan.stream_type === "glb" || streamUrl.toLowerCase().endsWith(".glb");
    if (window.TilesRenderer && !isGlbStream) {
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
        const sphere = new THREE.Sphere();
        if (computeTilesetContentSphere(tr, sphere)) {
          tr.group.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
          finalizeLoadedMultiAlignLayer(sphere);
        }
        studioThree.camera.updateMatrixWorld();
        tr.update();
      });

      tr.addEventListener("load-model", (ev) => {
        if (ev && ev.scene) {
          ev.scene.traverse((c) => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => applyBrightnessToMaterial(m, STATE.scanBrightness));
            }
          });
          studioThree.camera.updateMatrixWorld();
          tr.update();
          if (STATE.multiAlign?.active && hasStagedMeshEditsForActiveScan()) {
            applyStagedEditsToStudioMeshes(false);
          }
          if (studioThree.renderer && studioThree.scene && studioThree.camera) {
            studioThree.renderer.render(studioThree.scene, studioThree.camera);
          }
          if (
            STATE.multiAlign?.active &&
            ((Array.isArray(STATE.lassoStrokes) && STATE.lassoStrokes.length > 0) ||
              (Array.isArray(STATE.pendingCropPolygons) && STATE.pendingCropPolygons.length > 0) ||
              (Array.isArray(STATE.cropPolygonPoints) && STATE.cropPolygonPoints.length >= 3))
          ) {
            if (studioThree._lassoRebuildTimer) clearTimeout(studioThree._lassoRebuildTimer);
            studioThree._lassoRebuildTimer = setTimeout(() => {
              rebuildLassoHighlight3D();
            }, 90);
          }
        }
      });

      tr.errorTarget = 6.0;
      zUpGroup.add(tr.group);
      layer.tilesRenderer = tr;
      studioThree.camera.updateMatrixWorld();
      tr.update();
    } else if (isGlbStream && THREE.GLTFLoader) {
      const gltfLoader = new THREE.GLTFLoader();
      if (window.MeshoptDecoder) gltfLoader.setMeshoptDecoder(window.MeshoptDecoder);
      const ktx2 = getKTX2Loader(studioThree.renderer);
      if (ktx2) gltfLoader.setKTX2Loader(ktx2);
      gltfLoader.load(
        streamUrl,
        (gltf) => {
          const model = gltf.scene;
          // zUpGroup has rotation.x = 270 deg; rotate Y-up GLB +90 deg X so it renders upright inside zUpGroup
          model.rotation.x = Math.PI * 0.5;
          model.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(model);
          const sphere = new THREE.Sphere();
          box.getBoundingSphere(sphere);
          if (sphere.radius > 0) {
            model.position.set(-sphere.center.x, -sphere.center.y, -sphere.center.z);
          }
          model.traverse((c) => {
            if (c.isMesh && c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => applyBrightnessToMaterial(m, STATE.scanBrightness));
            }
          });
          zUpGroup.add(model);
          const metaE = Number(scan.twd97_e || 0);
          const metaN = Number(scan.twd97_n || 0);
          const metaH = Number(scan.twd97_h || 0);
          const worldSphere = new THREE.Sphere(
            new THREE.Vector3(
              metaE || sphere.center.x,
              metaN || sphere.center.y,
              metaH || sphere.center.z
            ),
            sphere.radius || 38
          );
          finalizeLoadedMultiAlignLayer(worldSphere);
          if (STATE.multiAlign?.active && hasStagedMeshEditsForActiveScan()) {
            applyStagedEditsToStudioMeshes(false);
          }
          if (studioThree.renderer && studioThree.scene && studioThree.camera) {
            studioThree.renderer.render(studioThree.scene, studioThree.camera);
          }
          if (STATE.multiAlign?.active && countMarkedRegionsPending() > 0) {
            if (studioThree._lassoRebuildTimer) clearTimeout(studioThree._lassoRebuildTimer);
            studioThree._lassoRebuildTimer = setTimeout(() => {
              rebuildLassoHighlight3D();
            }, 90);
          }
        },
        undefined,
        (err) => {
          console.warn("[GatheringScans] Multi-Align GLB layer load failed:", err);
        }
      );
    }

    syncStagedEditsDockBadge();
    applyLayerTransformTo3D(layer);
    return layer;
  }

  function removeScanLayerFromMultiAlign(scanId) {
    const idx = STATE.multiAlign.layers.findIndex((l) => l.scan_id === scanId);
    if (idx === -1) return;
    const layer = STATE.multiAlign.layers[idx];
    if (layer.tilesRenderer) {
      layer.zUpGroup.remove(layer.tilesRenderer.group);
      layer.tilesRenderer.dispose();
    }
    if (studioThree && studioThree.multiAlignGroup && layer.layerGroup) {
      studioThree.multiAlignGroup.remove(layer.layerGroup);
    }
    STATE.multiAlign.layers.splice(idx, 1);
    if (STATE.multiAlign.selectedScanId === scanId) {
      STATE.multiAlign.selectedScanId = STATE.multiAlign.layers[0]?.scan_id || null;
    }
    if (STATE.multiAlign.layers.length > 0 && STATE.multiAlign.layers[0].rawCenter) {
      STATE.multiAlign.refCenter = { ...STATE.multiAlign.layers[0].rawCenter };
    }
    syncStagedEditsDockBadge();
    updateStudioTransformGizmo();
  }

  function enterMultiScanAlignMode() {
    initStudio3D();
    if (!studioThree) return;
    if (STATE.multiAlign?.active) {
      syncMultiAlignToolAvailability();
      syncStagedEditsDockBadge();
      updateStudioTransformGizmo();
      return;
    }

    // Preserve any active Lasso strokes, locked polygons, unclosed >=3pt polygon, and staged edits
    // from Single-Scan mode so switching to Align & Merge NEVER discards selected polygons!
    preserveLassoSelectionBeforeToolSwitch();
    const anchorScanId = STATE.activeScanId || STATE.activeScan?.scan_id || "";
    const anchorZUpMat = new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(270));
    const tcSingle = Array.isArray(studioThree.tilesCenter) ? studioThree.tilesCenter.slice() : [0, 0, 0];

    const upgradeStrokeToAnchorLayer = (stObj) => {
      if (!stObj || !anchorScanId) return stObj;
      if (stObj.layer_zup_to_clip && stObj.layer_zup_to_clip[anchorScanId]) return stObj;
      if (Array.isArray(stObj.view_proj_matrix) && stObj.view_proj_matrix.length === 16) {
        const vpMat = new THREE.Matrix4().fromArray(stObj.view_proj_matrix);
        const lMat = new THREE.Matrix4().multiplyMatrices(vpMat, anchorZUpMat);
        stObj.layer_zup_to_clip = Object.assign({}, stObj.layer_zup_to_clip || {}, {
          [anchorScanId]: Array.from(lMat.elements),
        });
      }
      return stObj;
    };

    if (Array.isArray(STATE.lassoStrokes) && STATE.lassoStrokes.length > 0 && anchorScanId) {
      STATE.lassoStrokes.forEach((s) => upgradeStrokeToAnchorLayer(s));
    }
    if (STATE.cropMode === "keep_inside") {
      STATE.cropMode = "delete_inside";
    }

    const prevSingleStaged =
      STATE.stagedEdits && anchorScanId && STATE.stagedEdits.scanId === anchorScanId
        ? {
            deletions: Array.isArray(STATE.stagedEdits.deletions)
              ? STATE.stagedEdits.deletions.map((b) => {
                  const cloned = JSON.parse(JSON.stringify(b));
                  if (Array.isArray(cloned.frustum_strokes)) {
                    cloned.frustum_strokes.forEach((s) => upgradeStrokeToAnchorLayer(s));
                  }
                  if (
                    (!cloned.layer_centered_polygons || !cloned.layer_centered_polygons[anchorScanId]) &&
                    Array.isArray(cloned.native_polygons) &&
                    cloned.native_polygons.length > 0
                  ) {
                    cloned.layer_centered_polygons = Object.assign({}, cloned.layer_centered_polygons || {}, {
                      [anchorScanId]: cloned.native_polygons.map((poly) =>
                        poly.map((pt) => [Number(pt[0]) - (Number(tcSingle[0]) || 0), Number(pt[1]) - (Number(tcSingle[1]) || 0)])
                      ),
                    });
                  }
                  return cloned;
                })
              : [],
            compressionPreset: STATE.stagedEdits.compressionPreset || null,
            crsConfig: STATE.stagedEdits.crsConfig ? { ...STATE.stagedEdits.crsConfig } : null,
          }
        : null;

    restoreOriginalStudioMeshIndices();
    STATE.multiAlign.active = true;
    resetStagedEditsForScan(STATE.activeScan);
    if (prevSingleStaged) {
      if (prevSingleStaged.deletions.length > 0) {
        STATE.stagedEdits.deletions = prevSingleStaged.deletions;
        STATE.stagedEdits.rev = (STATE.stagedEdits.rev || 0) + 1;
      }
      if (prevSingleStaged.compressionPreset) {
        STATE.stagedEdits.compressionPreset = prevSingleStaged.compressionPreset;
      }
      if (prevSingleStaged.crsConfig) {
        STATE.stagedEdits.crsConfig = prevSingleStaged.crsConfig;
      }
    }

    studioThree.modelPivot.visible = false;
    if (studioThree.fallbackGroup) studioThree.fallbackGroup.visible = false;
    studioThree.multiAlignGroup.visible = true;

    if (STATE.multiAlign.layers.length === 0 && STATE.activeScanId) {
      // Only include the currently active Studio scan as the starting anchor (#1);
      // the user selects which additional scans to import from the checklist in the panel.
      addScanLayerToMultiAlign(STATE.activeScanId);
    }
    if (hasStagedMeshEditsForActiveScan()) {
      applyStagedEditsToStudioMeshes(true);
    }
    if (countMarkedRegionsPending() > 0) {
      if (studioThree._lassoRebuildTimer) clearTimeout(studioThree._lassoRebuildTimer);
      studioThree._lassoRebuildTimer = setTimeout(() => {
        rebuildLassoHighlight3D();
      }, 110);
    }
    syncMultiAlignToolAvailability();
    syncStagedEditsDockBadge();
    updateStudioTransformGizmo();
  }

  function exitMultiScanAlignMode(reloadActive = true) {
    if (!studioThree) return;
    _gizmoDrag.active = false;
    clearLassoSelectionState();
    restoreOriginalStudioMeshIndices();
    STATE.multiAlign.layers.slice().forEach((l) => removeScanLayerFromMultiAlign(l.scan_id));
    STATE.multiAlign.active = false;
    STATE.multiAlign.selectedScanId = null;
    STATE.multiAlign.refCenter = null;
    resetStagedEditsForScan(STATE.activeScan);
    syncMultiAlignToolAvailability();
    if (studioThree.multiAlignGroup) studioThree.multiAlignGroup.visible = false;
    if (studioThree.gizmoGroup) studioThree.gizmoGroup.visible = false;
    studioThree.modelPivot.visible = true;
    studioThree.controls.enabled = true;
    if (reloadActive && STATE.activeScanId) {
      loadScanIntoStudio(STATE.activeScanId);
    }
  }

  function renderAlignMergeInspectorContent() {
    const layers = STATE.multiAlign.layers;
    const allLocked = layers.length >= 2 && layers.every((l) => l.locked);
    const lockedCount = layers.filter((l) => l.locked).length;
    const curSite =
      STATE.activeScan?.project_group ||
      (STATE.activeProjectGroup && STATE.activeProjectGroup !== "__all__" ? STATE.activeProjectGroup : "") ||
      STATE.scans[0]?.project_group ||
      "Unassigned Site";
    const pickerProject = STATE.multiAlign.pickerProjectGroup || curSite;
    const defaultMergedName = `${curSite} — Unified Merged Scan (${Math.max(2, layers.length)} Scans)`;

    const allProjectNames = Array.from(
      new Set(STATE.scans.map((s) => s.project_group || "Default"))
    ).sort();
    const projectFilterOptionsHtml = [
      `<option value="__all__" ${pickerProject === "__all__" ? "selected" : ""}>All Projects (${STATE.scans.length} Scans)</option>`,
      ...allProjectNames.map((pg) => {
        const cnt = STATE.scans.filter((s) => (s.project_group || "Default") === pg).length;
        return `<option value="${escapeHtml(pg)}" ${pickerProject === pg ? "selected" : ""}>${escapeHtml(pg)} (${cnt} Scans)</option>`;
      }),
    ].join("");

    const candidateScans = STATE.scans
      .filter((s) => pickerProject === "__all__" || (s.project_group || "Default") === pickerProject)
      .sort((a, b) => String(a.name || a.scan_id).localeCompare(String(b.name || b.scan_id)));

    if (!STATE.multiAlign.checkedScanIds) {
      STATE.multiAlign.checkedScanIds = new Set();
    }

    const scanChecklistRowsHtml = candidateScans
      .map((s) => {
        const loadedIdx = layers.findIndex((l) => l.scan_id === s.scan_id);
        const isLoaded = loadedIdx !== -1;
        const loadedLayer = isLoaded ? layers[loadedIdx] : null;
        const isChecked = !isLoaded && STATE.multiAlign.checkedScanIds.has(s.scan_id);
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 7px;border-radius:6px;background:${
            isLoaded
              ? "rgba(56,189,248,0.10)"
              : isChecked
              ? "var(--ui-accent-soft)"
              : "var(--ui-bg-surface)"
          };border:1px solid ${
            isLoaded
              ? escapeHtml(loadedLayer.color)
              : isChecked
              ? "var(--ui-accent)"
              : "var(--ui-border)"
          };">
            <label style="display:flex;align-items:center;gap:7px;min-width:0;flex:1;cursor:pointer;margin:0;">
              ${
                isLoaded
                  ? `<span style="width:12px;height:12px;border-radius:50%;background:${loadedLayer.color};display:inline-block;flex-shrink:0;" title="Loaded in 3D View"></span>`
                  : `<input type="checkbox" class="chk-align-pick-scan" data-scan-id="${escapeHtml(s.scan_id)}" ${
                      isChecked ? "checked" : ""
                    } style="accent-color:var(--ui-accent);width:14px;height:14px;margin:0;flex-shrink:0;cursor:pointer;" />`
              }
              <div style="min-width:0;flex:1;">
                <div style="font-size:11.5px;font-weight:600;color:var(--ui-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${escapeHtml(s.name || s.scan_id)}
                </div>
                <div style="font-size:10px;color:var(--ui-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${escapeHtml(s.project_group || "")}${s.capture_date ? ` · ${escapeHtml(s.capture_date)}` : ""}
                </div>
              </div>
            </label>
            ${
              isLoaded
                ? `<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:rgba(16,185,129,0.16);color:#10b981;flex-shrink:0;">#${
                    loadedIdx + 1
                  }${loadedIdx === 0 ? " Anchor" : " Loaded"}</span>
                   <button type="button" class="gs-top-btn btn-align-remove" data-scan-id="${escapeHtml(
                     s.scan_id
                   )}" style="padding:1px 6px;font-size:10px;flex-shrink:0;" title="Remove from 3D alignment view">✕</button>`
                : `<button type="button" class="gs-top-btn btn-align-quick-add" data-scan-id="${escapeHtml(
                    s.scan_id
                  )}" style="padding:2px 7px;font-size:10.5px;flex-shrink:0;" title="Add this scan to 3D alignment view">+ Add</button>`
            }
          </div>
        `;
      })
      .join("");

    const checkedCount = candidateScans.filter(
      (s) => !layers.some((l) => l.scan_id === s.scan_id) && STATE.multiAlign.checkedScanIds.has(s.scan_id)
    ).length;

    const layerCardsHtml =
      layers.length === 0
        ? `<div style="padding:12px;border:1px dashed var(--ui-border-strong);border-radius:8px;text-align:center;font-size:11.5px;color:var(--ui-text-secondary);">
            No scan layers in 3D view yet. Check scans above and click <b>+ Add Selected Scans</b>.
          </div>`
        : layers
            .map((l, idx) => {
              const isSel = l.scan_id === STATE.multiAlign.selectedScanId;
              const disAttr = l.locked ? "disabled" : "";
              return `
              <div class="align-layer-card" data-scan-id="${l.scan_id}" style="background:${
                isSel ? "var(--ui-bg-elevated)" : "var(--ui-bg-subtle)"
              };border:1.5px solid ${
                isSel ? l.color : "var(--ui-border)"
              };border-radius:8px;padding:9px 10px;margin-bottom:8px;transition:border-color 0.15s;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;">
                  <div style="display:flex;align-items:center;gap:6px;min-width:0;cursor:pointer;" class="btn-select-align-layer" data-scan-id="${l.scan_id}" title="Click to attach 3D Move/Rotate Gizmo to this scan">
                    <span style="width:11px;height:11px;border-radius:50%;background:${l.color};flex-shrink:0;box-shadow:0 0 0 2px rgba(255,255,255,0.15);"></span>
                    <span style="font-size:12px;font-weight:700;color:var(--ui-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                      #${idx + 1} ${l.name}
                    </span>
                    ${
                      idx === 0
                        ? `<span style="font-size:9.5px;padding:1px 5px;border-radius:4px;background:rgba(56,189,248,0.16);color:#38bdf8;font-weight:600;">ANCHOR</span>`
                        : ""
                    }
                  </div>
                  <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
                    <button type="button" class="gs-top-btn btn-align-tint ${l.tintEnabled ? "accent" : ""}" data-scan-id="${l.scan_id}" style="padding:2px 6px;font-size:10px;" title="Toggle false-color tint on this scan to inspect overlap">
                      🎨
                    </button>
                    <button type="button" class="gs-top-btn btn-align-vis" data-scan-id="${l.scan_id}" style="padding:2px 6px;font-size:10px;opacity:${l.visible ? 1 : 0.45};" title="Show/Hide scan layer">
                      ${l.visible ? "👁" : "🚫"}
                    </button>
                    <button type="button" class="gs-top-btn btn-align-lock ${l.locked ? "accent" : ""}" data-scan-id="${l.scan_id}" style="padding:2px 7px;font-size:10.5px;font-weight:700;${
                      l.locked
                        ? "background:#10b981;border-color:#059669;color:#ffffff;"
                        : ""
                    }" title="${l.locked ? "Orientation Locked (Click to Unlock)" : "Lock Orientation before Merging"}">
                      ${l.locked ? "🔒 Locked" : "🔓 Lock"}
                    </button>
                    <button type="button" class="gs-top-btn btn-align-remove" data-scan-id="${l.scan_id}" style="padding:2px 6px;font-size:10px;" title="Remove scan from alignment view">
                      ✕
                    </button>
                  </div>
                </div>

                <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:5px;font-size:10.5px;">
                  <div>
                    <label style="display:block;color:#ef4444;font-weight:600;margin-bottom:2px;">Move X (E m)</label>
                    <input type="number" step="0.1" class="gs-input align-num-input" data-scan-id="${l.scan_id}" data-field="tx" value="${Number(l.tx || 0).toFixed(2)}" ${disAttr} style="padding:3px 5px;font-size:11px;width:100%;" />
                  </div>
                  <div>
                    <label style="display:block;color:#22c55e;font-weight:600;margin-bottom:2px;">Elev Y (H m)</label>
                    <input type="number" step="0.1" class="gs-input align-num-input" data-scan-id="${l.scan_id}" data-field="ty" value="${Number(l.ty || 0).toFixed(2)}" ${disAttr} style="padding:3px 5px;font-size:11px;width:100%;" />
                  </div>
                  <div>
                    <label style="display:block;color:#3b82f6;font-weight:600;margin-bottom:2px;">Move Z (N m)</label>
                    <input type="number" step="0.1" class="gs-input align-num-input" data-scan-id="${l.scan_id}" data-field="tz" value="${Number(l.tz || 0).toFixed(2)}" ${disAttr} style="padding:3px 5px;font-size:11px;width:100%;" />
                  </div>
                  <div>
                    <label style="display:block;color:#10b981;font-weight:600;margin-bottom:2px;">Yaw Ry (°)</label>
                    <input type="number" step="0.5" class="gs-input align-num-input" data-scan-id="${l.scan_id}" data-field="ry_deg" value="${Number(l.ry_deg || 0).toFixed(1)}" ${disAttr} style="padding:3px 5px;font-size:11px;width:100%;" />
                  </div>
                  <div>
                    <label style="display:block;color:#f87171;font-weight:600;margin-bottom:2px;">Pitch Rx (°)</label>
                    <input type="number" step="0.5" class="gs-input align-num-input" data-scan-id="${l.scan_id}" data-field="rx_deg" value="${Number(l.rx_deg || 0).toFixed(1)}" ${disAttr} style="padding:3px 5px;font-size:11px;width:100%;" />
                  </div>
                  <div>
                    <label style="display:block;color:#60a5fa;font-weight:600;margin-bottom:2px;">Roll Rz (°)</label>
                    <input type="number" step="0.5" class="gs-input align-num-input" data-scan-id="${l.scan_id}" data-field="rz_deg" value="${Number(l.rz_deg || 0).toFixed(1)}" ${disAttr} style="padding:3px 5px;font-size:11px;width:100%;" />
                  </div>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;gap:4px;">
                  <button type="button" class="gs-top-btn btn-select-align-layer ${isSel ? "accent" : ""}" data-scan-id="${l.scan_id}" style="padding:2px 8px;font-size:10.5px;flex:1;justify-content:center;">
                    <span>${isSel ? "🎯 Gizmo Active" : "Select for 3D Gizmo"}</span>
                  </button>
                  <button type="button" class="gs-top-btn btn-align-rot90" data-scan-id="${l.scan_id}" ${disAttr} style="padding:2px 7px;font-size:10.5px;" title="Rotate Yaw +90°">
                    <span>↻ +90°</span>
                  </button>
                  <button type="button" class="gs-top-btn btn-align-zero" data-scan-id="${l.scan_id}" ${disAttr} style="padding:2px 7px;font-size:10.5px;" title="Reset this scan to (0,0,0) and 0° rotation">
                    <span>Reset</span>
                  </button>
                </div>
              </div>
            `;
            })
            .join("");

    const postMergeHtml = STATE.multiAlign.lastMergedScan
      ? `
        <div style="margin-top:10px;padding:10px;border-radius:8px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.4);font-size:11.5px;">
          <div style="font-weight:700;color:#10b981;margin-bottom:4px;">
            ✓ Merged Scan Ready: ${STATE.multiAlign.lastMergedScan.name}
          </div>
          <div style="color:var(--ui-text-secondary);font-size:11px;margin-bottom:8px;">
            Loaded as the active Studio scan. Apply existing tools directly to this unified scan:
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;">
            <button type="button" class="gs-top-btn accent" id="btnPostMergeOptimize" style="justify-content:center;font-size:11px;">
              <span>⚡ Optimize / Crop</span>
            </button>
            <button type="button" class="gs-top-btn" id="btnPostMergeVolume" style="justify-content:center;font-size:11px;">
              <span>📐 Cut/Fill Volume</span>
            </button>
            <button type="button" class="gs-top-btn" id="btnPostMergeContours" style="justify-content:center;font-size:11px;">
              <span>🗺️ Contours / DXF</span>
            </button>
            <button type="button" class="gs-top-btn" id="btnPostMergeSection" style="justify-content:center;font-size:11px;">
              <span>🧊 3D Section Box</span>
            </button>
          </div>
        </div>
      `
      : "";

    showSidePanel(
      "Multi-Scan 3D Alignment & Merge (多掃描對齊與合併)",
      `
      <!-- Step 1: User-Controlled Scan Selector Checklist -->
      <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:9px 10px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;">
          <span style="font-size:11.5px;font-weight:700;color:var(--ui-text-primary);">1. Select Scans to Add (選擇要加入的掃描)</span>
          <div style="display:flex;gap:4px;">
            <button type="button" class="gs-top-btn" id="btnAlignCheckAllCandidates" style="padding:1px 6px;font-size:10px;" title="Check all unloaded scans in this list">Select All</button>
            <button type="button" class="gs-top-btn" id="btnAlignUncheckAllCandidates" style="padding:1px 6px;font-size:10px;" title="Uncheck all">Clear</button>
          </div>
        </div>

        <div style="margin-bottom:6px;">
          <select class="gs-select" id="alignProjectFilterSelect" style="width:100%;font-size:11.5px;height:28px;" title="Filter scans by project site">
            ${projectFilterOptionsHtml}
          </select>
        </div>

        <div id="alignScanPickerChecklist" style="display:flex;flex-direction:column;gap:4px;max-height:155px;overflow-y:auto;padding-right:2px;margin-bottom:7px;">
          ${scanChecklistRowsHtml}
        </div>

        <button type="button" class="gs-top-btn accent" id="btnAlignAddCheckedScans" style="width:100%;justify-content:center;font-size:11.5px;font-weight:700;padding:6px 10px;">
          <span>+ Add Selected Scans to 3D View (${checkedCount} Checked)</span>
        </button>
      </div>

      <!-- Step 2: 3D Gizmo Mode & Active Layers -->
      <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:6px;">
        <span style="font-size:11.5px;font-weight:700;color:var(--ui-text-primary);">2. Active 3D Layers (${layers.length} Loaded)</span>
        <div style="display:flex;gap:4px;">
          <button type="button" class="gs-top-btn" id="btnAlignSpreadScans" style="padding:2px 7px;font-size:10.5px;" title="Spread unlocked scans side-by-side along X so you can inspect them individually">
            <span>Spread</span>
          </button>
          <button type="button" class="gs-top-btn" id="btnAlignStackOrigin" style="padding:2px 7px;font-size:10.5px;" title="Co-locate unlocked scans at (0,0,0)">
            <span>Co-locate</span>
          </button>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:8px;background:var(--ui-bg-subtle);padding:5px 7px;border-radius:7px;border:1px solid var(--ui-border);">
        <span style="font-size:11px;font-weight:600;color:var(--ui-text-secondary);">3D Gizmo Mode:</span>
        <div style="display:flex;gap:4px;">
          <button type="button" class="gs-top-btn btn-gizmo-mode ${STATE.multiAlign.gizmoMode === "both" ? "accent" : ""}" data-mode="both" style="padding:2px 7px;font-size:10.5px;">
            <span>Move + Rotate (R)</span>
          </button>
          <button type="button" class="gs-top-btn btn-gizmo-mode ${STATE.multiAlign.gizmoMode === "translate" ? "accent" : ""}" data-mode="translate" style="padding:2px 7px;font-size:10.5px;">
            <span>Move (W)</span>
          </button>
          <button type="button" class="gs-top-btn btn-gizmo-mode ${STATE.multiAlign.gizmoMode === "rotate" ? "accent" : ""}" data-mode="rotate" style="padding:2px 7px;font-size:10.5px;">
            <span>Rotate (E)</span>
          </button>
        </div>
      </div>

      <div id="alignLayersList" style="max-height:270px;overflow-y:auto;padding-right:2px;margin-bottom:8px;">
        ${layerCardsHtml}
      </div>

      <div style="display:flex;gap:6px;margin-bottom:10px;">
        <button type="button" class="gs-top-btn ${allLocked ? "accent" : ""}" id="btnAlignLockAll" style="flex:1;justify-content:center;font-size:11.5px;${
          allLocked ? "background:#10b981;border-color:#059669;color:#fff;" : ""
        }">
          <span>🔒 Lock All Orientations (${lockedCount}/${layers.length})</span>
        </button>
        <button type="button" class="gs-top-btn" id="btnAlignUnlockAll" style="justify-content:center;font-size:11.5px;">
          <span>🔓 Unlock All</span>
        </button>
      </div>

      <div style="border-top:1px solid var(--ui-border);padding-top:10px;">
        <div class="gs-form-group" style="margin-bottom:7px;">
          <label style="font-size:11px;">Unified Scan Name (合併後新掃描名稱)</label>
          <input type="text" class="gs-input" id="alignMergedScanName" value="${defaultMergedName}" style="font-size:12px;" />
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
          <div class="gs-form-group" style="margin-bottom:0;">
            <label style="font-size:11px;">Target Project Site</label>
            <input type="text" class="gs-input" id="alignMergedProjectGroup" value="${curSite}" style="font-size:11.5px;" />
          </div>
          <div class="gs-form-group" style="margin-bottom:0;">
            <label style="font-size:11px;">Post-Merge Optimizer</label>
            <select class="gs-select" id="alignPostOptPreset" style="font-size:11.5px;">
              <option value="none" ${!ensureStagedEditsForActiveScan().compressionPreset ? "selected" : ""}>Keep Native Merged Mesh</option>
              <option value="balanced" ${ensureStagedEditsForActiveScan().compressionPreset === "balanced" ? "selected" : ""}>Auto-Run Balanced (50% Tris)</option>
              <option value="quality" ${ensureStagedEditsForActiveScan().compressionPreset === "quality" ? "selected" : ""}>Auto-Run High Quality (75% Tris)</option>
              <option value="web" ${ensureStagedEditsForActiveScan().compressionPreset === "web" ? "selected" : ""}>Auto-Run Fast Tablet (35% Tris)</option>
              <option value="ultra_light" ${ensureStagedEditsForActiveScan().compressionPreset === "ultra_light" ? "selected" : ""}>Auto-Run Ultra-Light (20% Tris)</option>
            </select>
          </div>
        </div>

        ${(() => {
          const stMulti = ensureStagedEditsForActiveScan();
          const delRegs = (stMulti.deletions || []).reduce((acc, b) => acc + (Number(b.regionCount) || 1), 0);
          const delTris = (stMulti.deletions || []).reduce((acc, b) => acc + (Number(b.triCount) || 0), 0);
          const pendingRegs = countMarkedRegionsPending();
          const pendingTris = Number(STATE.lassoSelectedTriCount) || 0;
          const crsItem = stMulti.crsConfig
            ? CRS_UI_CATALOG.find((c) => c.code === stMulti.crsConfig.target_crs)
            : null;
          const chips = [];
          if (pendingRegs > 0) {
            chips.push(
              `<span style="color:#ef4444;font-weight:700;">🔴 ${pendingRegs} selected polygon${
                pendingRegs === 1 ? "" : "s"
              }${pendingTris > 0 ? ` (~${pendingTris.toLocaleString()} tris)` : ""} preserved</span>`
            );
          }
          if (delRegs > 0) {
            chips.push(`🗑️ ${delRegs} deleted region${delRegs === 1 ? "" : "s"} (-${delTris.toLocaleString()} tris)`);
          }
          if (crsItem) {
            chips.push(`🌐 CRS: ${escapeHtml(crsItem.shortLabel)}`);
          }
          return `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:5px;flex-wrap:wrap;margin-bottom:8px;padding:6px 8px;border-radius:7px;background:var(--ui-bg-subtle);border:1px solid ${
              pendingRegs > 0 ? "rgba(239,68,68,0.45)" : "var(--ui-border)"
            };font-size:10.5px;">
              <span style="color:var(--ui-text-secondary);">${
                chips.length > 0
                  ? `<b>Included in Merge:</b> ${chips.join(" · ")}`
                  : `Tip: Use <b>Lasso Delete (套索刪除)</b> or <b>CRS (座標系統)</b> before merging!`
              }</span>
              <div style="display:flex;gap:4px;flex-wrap:wrap;">
                ${
                  pendingRegs > 0
                    ? `<button type="button" class="gs-top-btn accent" id="btnAlignCommitPendingLasso" style="padding:2px 7px;font-size:10px;background:#ef4444;border-color:#dc2626;color:#fff;" title="Apply live 3D deletion to the preserved red polygon(s)">✓ Delete Selected (${pendingRegs})</button>`
                    : ""
                }
                <button type="button" class="gs-top-btn" id="btnAlignOpenLassoDelete" style="padding:2px 7px;font-size:10px;border-color:rgba(239,68,68,0.4);color:#ef4444;">🗑️ ${
                  pendingRegs > 0 ? "Edit Polygons" : "Lasso Delete"
                }</button>
                <button type="button" class="gs-top-btn" id="btnAlignOpenCrs" style="padding:2px 7px;font-size:10px;">🌐 CRS</button>
              </div>
            </div>
          `;
        })()}

        <label style="display:flex;align-items:center;gap:7px;margin-bottom:8px;padding:6px 8px;border-radius:7px;background:var(--ui-bg-subtle);border:1px solid var(--ui-border);font-size:11px;color:var(--ui-text-secondary);cursor:pointer;">
          <input type="checkbox" id="chkAlignArchiveOriginals" ${
            STATE.multiAlign.archiveOriginals === true ? "checked" : ""
          } style="accent-color:#10b981;width:14px;height:14px;margin:0;cursor:pointer;flex-shrink:0;" />
          <span>Optional: move individual source scans to <b>Trash Bin</b> after merge (選填：合併後將個別原掃描移至回收桶；預設保留所有個別掃描)</span>
        </label>

        <button type="button" class="gs-top-btn accent" id="btnExecuteMergeScans" style="width:100%;justify-content:center;padding:8px 12px;font-weight:700;${
          allLocked ? "" : "opacity:0.85;"
        }">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
          </svg>
          <span>${
            allLocked
              ? `Merge ${layers.length} Locked Scans into Unified Scan`
              : `Lock All Scans (🔒) to Merge (${lockedCount}/${layers.length} Locked)`
          }</span>
        </button>

        <button type="button" class="gs-top-btn" id="btnExitMultiAlign" style="width:100%;justify-content:center;margin-top:6px;font-size:11px;">
          <span>Exit Multi-Scan Alignment View</span>
        </button>
      </div>

      <div id="alignMergeResultBox" style="margin-top:8px;"></div>
      ${postMergeHtml}
      `
    );

    // Wire scan selector checklist events
    document.getElementById("alignProjectFilterSelect")?.addEventListener("change", (ev) => {
      STATE.multiAlign.pickerProjectGroup = ev.target.value;
      renderAlignMergeInspectorContent();
    });

    document.querySelectorAll(".chk-align-pick-scan").forEach((chk) => {
      chk.addEventListener("change", () => {
        const sid = chk.dataset.scanId;
        if (!sid) return;
        if (chk.checked) {
          STATE.multiAlign.checkedScanIds.add(sid);
        } else {
          STATE.multiAlign.checkedScanIds.delete(sid);
        }
        renderAlignMergeInspectorContent();
      });
    });

    document.querySelectorAll(".btn-align-quick-add").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const sid = btn.dataset.scanId;
        if (!sid) return;
        if (!STATE.multiAlign.active) enterMultiScanAlignMode();
        addScanLayerToMultiAlign(sid);
        STATE.multiAlign.checkedScanIds?.delete(sid);
        renderAlignMergeInspectorContent();
        const added = STATE.scans.find((s) => s.scan_id === sid);
        showToast(`Added "${added?.name || sid}" to 3D alignment view`);
      });
    });

    document.getElementById("btnAlignCheckAllCandidates")?.addEventListener("click", () => {
      candidateScans.forEach((s) => {
        if (!STATE.multiAlign.layers.some((l) => l.scan_id === s.scan_id)) {
          STATE.multiAlign.checkedScanIds.add(s.scan_id);
        }
      });
      renderAlignMergeInspectorContent();
    });

    document.getElementById("btnAlignUncheckAllCandidates")?.addEventListener("click", () => {
      STATE.multiAlign.checkedScanIds.clear();
      renderAlignMergeInspectorContent();
    });

    document.getElementById("btnAlignAddCheckedScans")?.addEventListener("click", () => {
      const toAdd = candidateScans.filter(
        (s) =>
          !STATE.multiAlign.layers.some((l) => l.scan_id === s.scan_id) &&
          STATE.multiAlign.checkedScanIds.has(s.scan_id)
      );
      if (toAdd.length === 0) {
        showToast("Please check at least one scan in the list above (or click '+ Add' next to a scan).");
        return;
      }
      if (!STATE.multiAlign.active) enterMultiScanAlignMode();
      toAdd.forEach((s) => {
        addScanLayerToMultiAlign(s.scan_id);
        STATE.multiAlign.checkedScanIds.delete(s.scan_id);
      });
      renderAlignMergeInspectorContent();
      showToast(`Added ${toAdd.length} selected scan(s) to 3D alignment view`);
    });

    document.getElementById("btnAlignSpreadScans")?.addEventListener("click", () => {
      STATE.multiAlign.layers.forEach((l, i) => {
        if (l.locked) return;
        l.tx = Number(((i - (STATE.multiAlign.layers.length - 1) * 0.5) * 18).toFixed(2));
        l.ty = 0;
        l.tz = 0;
        l._userMoved = true;
        applyLayerTransformTo3D(l);
      });
      renderAlignMergeInspectorContent();
      showToast("Spread unlocked scans along X axis for clear visual inspection");
    });

    document.getElementById("btnAlignStackOrigin")?.addEventListener("click", () => {
      STATE.multiAlign.layers.forEach((l) => {
        if (l.locked) return;
        l.tx = 0;
        l.ty = 0;
        l.tz = 0;
        l._userMoved = true;
        applyLayerTransformTo3D(l);
      });
      renderAlignMergeInspectorContent();
      showToast("Co-located unlocked scans at (0, 0, 0)");
    });

    document.querySelectorAll(".btn-gizmo-mode").forEach((btn) => {
      btn.addEventListener("click", () => {
        STATE.multiAlign.gizmoMode = btn.dataset.mode || "both";
        updateStudioTransformGizmo();
        renderAlignMergeInspectorContent();
      });
    });

    document.querySelectorAll(".btn-select-align-layer").forEach((btn) => {
      btn.addEventListener("click", () => {
        STATE.multiAlign.selectedScanId = btn.dataset.scanId;
        updateStudioTransformGizmo();
        renderAlignMergeInspectorContent();
      });
    });

    document.querySelectorAll(".btn-align-tint").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const l = STATE.multiAlign.layers.find((x) => x.scan_id === btn.dataset.scanId);
        if (l) {
          l.tintEnabled = !l.tintEnabled;
          renderAlignMergeInspectorContent();
        }
      });
    });

    document.querySelectorAll(".btn-align-vis").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const l = STATE.multiAlign.layers.find((x) => x.scan_id === btn.dataset.scanId);
        if (l) {
          l.visible = !l.visible;
          if (l.layerGroup) l.layerGroup.visible = l.visible;
          if (countMarkedRegionsPending() > 0) rebuildLassoHighlight3D();
          updateStudioTransformGizmo();
          renderAlignMergeInspectorContent();
        }
      });
    });

    document.querySelectorAll(".btn-align-lock").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const l = STATE.multiAlign.layers.find((x) => x.scan_id === btn.dataset.scanId);
        if (l) {
          l.locked = !l.locked;
          updateStudioTransformGizmo();
          renderAlignMergeInspectorContent();
          showToast(
            l.locked
              ? `Locked orientation for "${l.name}" 🔒`
              : `Unlocked "${l.name}" 🔓`
          );
        }
      });
    });

    document.querySelectorAll(".btn-align-remove").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        removeScanLayerFromMultiAlign(btn.dataset.scanId);
        renderAlignMergeInspectorContent();
      });
    });

    document.querySelectorAll(".btn-align-rot90").forEach((btn) => {
      btn.addEventListener("click", () => {
        const l = STATE.multiAlign.layers.find((x) => x.scan_id === btn.dataset.scanId);
        if (!l || l.locked) return;
        l.ry_deg = Number((((l.ry_deg + 90 + 180) % 360 + 360) % 360 - 180).toFixed(1));
        l._userMoved = true;
        applyLayerTransformTo3D(l);
        syncAlignLayerInputsInDOM(l);
      });
    });

    document.querySelectorAll(".btn-align-zero").forEach((btn) => {
      btn.addEventListener("click", () => {
        const l = STATE.multiAlign.layers.find((x) => x.scan_id === btn.dataset.scanId);
        if (!l || l.locked) return;
        l.tx = 0;
        l.ty = 0;
        l.tz = 0;
        l.rx_deg = 0;
        l.ry_deg = 0;
        l.rz_deg = 0;
        l._userMoved = true;
        applyLayerTransformTo3D(l);
        syncAlignLayerInputsInDOM(l);
      });
    });

    document.querySelectorAll(".align-num-input").forEach((inp) => {
      inp.addEventListener("input", () => {
        const l = STATE.multiAlign.layers.find((x) => x.scan_id === inp.dataset.scanId);
        if (!l || l.locked) return;
        const field = inp.dataset.field;
        const val = parseFloat(inp.value);
        if (Number.isFinite(val)) {
          l[field] = val;
          l._userMoved = true;
          STATE.multiAlign.selectedScanId = l.scan_id;
          applyLayerTransformTo3D(l);
        }
      });
    });

    document.getElementById("btnAlignLockAll")?.addEventListener("click", () => {
      STATE.multiAlign.layers.forEach((l) => {
        l.locked = true;
      });
      updateStudioTransformGizmo();
      renderAlignMergeInspectorContent();
      showToast(`All ${STATE.multiAlign.layers.length} scan orientations locked 🔒 — ready to merge!`);
    });

    document.getElementById("btnAlignUnlockAll")?.addEventListener("click", () => {
      STATE.multiAlign.layers.forEach((l) => {
        l.locked = false;
      });
      updateStudioTransformGizmo();
      renderAlignMergeInspectorContent();
      showToast("Unlocked all scan layers 🔓");
    });

    document.getElementById("chkAlignArchiveOriginals")?.addEventListener("change", (ev) => {
      STATE.multiAlign.archiveOriginals = Boolean(ev.target.checked);
    });

    document.getElementById("btnAlignCommitPendingLasso")?.addEventListener("click", () => {
      const committed = commitPendingLassoMarksToStagedEdits("delete_inside");
      renderAlignMergeInspectorContent();
      if (committed.committed) {
        showToast(
          `Deleted ${committed.regionCount} selected polygon(s) in live 3D preview (${(committed.hiddenTris || 0).toLocaleString()} tris hidden)`
        );
      }
    });

    document.getElementById("btnAlignOpenLassoDelete")?.addEventListener("click", () => {
      STATE.cropMode = "delete_inside";
      openLassoDeleteInspector({ armLasso: true });
      showToast("Lasso active across visible scan layers — mark regions & press Delete, or Return to Alignment anytime!");
    });

    document.getElementById("btnAlignOpenCrs")?.addEventListener("click", () => {
      preserveLassoSelectionBeforeToolSwitch();
      setActiveStudioTool("crs");
      openCoordinateSystemInspector();
    });

    document.getElementById("btnExitMultiAlign")?.addEventListener("click", () => {
      exitMultiScanAlignMode(true);
      document.getElementById("studioSidePanel")?.classList.remove("active");
      setActiveStudioTool("distance");
    });

    document.getElementById("btnExecuteMergeScans")?.addEventListener("click", async () => {
      if (STATE.multiAlign.layers.length < 2) {
        showToast("Please load at least 2 scans to merge.");
        return;
      }
      if (STATE.multiAlign.layers.some((l) => !l.ready)) {
        showToast("Please wait a moment for all 3D scan layers to finish loading their bounds before merging.");
        return;
      }
      const unlocked = STATE.multiAlign.layers.filter((l) => !l.locked);
      if (unlocked.length > 0) {
        showToast(
          `Please lock all scan orientations (🔒) before merging (${unlocked.length} still unlocked).`
        );
        return;
      }

      if (countMarkedRegionsPending() > 0) {
        commitPendingLassoMarksToStagedEdits("delete_inside");
      }

      const stMulti = ensureStagedEditsForActiveScan();
      const mergedName =
        document.getElementById("alignMergedScanName")?.value?.trim() ||
        stMulti.newScanName ||
        defaultMergedName;
      const mergedProject =
        document.getElementById("alignMergedProjectGroup")?.value?.trim() ||
        curSite;
      const postOptPresetRaw =
        document.getElementById("alignPostOptPreset")?.value || "none";
      const effectiveCompression =
        postOptPresetRaw && postOptPresetRaw !== "none"
          ? postOptPresetRaw
          : stMulti.compressionPreset || "";
      const archiveOriginals = STATE.multiAlign.archiveOriginals === true;

      const resBox = document.getElementById("alignMergeResultBox");
      if (resBox) {
        resBox.innerHTML = `<div style="padding:10px;border-radius:8px;background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);font-size:12px;color:var(--ui-accent);">
          Merging ${STATE.multiAlign.layers.length} locked scans, applying deletions / CRS / compression${
            archiveOriginals ? ", and moving source scan backups to Trash Bin" : ""
          }...
        </div>`;
      }

      try {
        const serializedLayers = serializeMultiAlignLayersForMerge(false);
        const refC = STATE.multiAlign.refCenter || STATE.multiAlign.layers[0]?.rawCenter || null;
        const payload = {
          name: mergedName,
          new_scan_name: mergedName,
          project_group: mergedProject,
          ref_center_zup: refC ? [Number(refC.x), Number(refC.y), Number(refC.z)] : null,
          layers: serializedLayers,
          scans: serializedLayers,
          deletions: stMulti.deletions || [],
          compression_preset: effectiveCompression,
          crs_config: stMulti.crsConfig || null,
          archive_originals_to_bin: archiveOriginals,
        };

        const res = await apiPost("/api/scans/merge", payload);

        if (typeof res.bin_scans_count === "number") {
          updateRecycleBinBadges(res.bin_scans_count);
        } else if (Array.isArray(res.bin_scans)) {
          updateRecycleBinBadges(res.bin_scans.length);
        }

        STATE.multiAlign.lastMergedScan = res.scan || {
          scan_id: res.scan_id,
          name: mergedName,
          project_group: mergedProject,
        };

        await refreshScansCatalog();
        exitMultiScanAlignMode(false);
        loadScanIntoStudio(res.scan_id);
        renderAlignMergeInspectorContent();

        const finalBox = document.getElementById("alignMergeResultBox");
        if (finalBox) {
          const outMb = res.output_mb ?? res.glb_size_mb ?? 0;
          const archivedCount = Number(res.archived_to_bin_count) || 0;
          finalBox.innerHTML = `
            <div style="background:var(--ui-bg-subtle);border:1px solid var(--ui-border-strong);border-radius:8px;padding:10px;font-size:12px;color:var(--ui-text-primary);">
              <div style="color:#10b981;font-weight:700;">✓ Unified Scan Saved (${res.duration_s}s)</div>
              <div style="margin-top:3px;">Scan ID: <code>${res.scan_id}</code></div>
              <div>Coordinate System: <b>${escapeHtml(res.crs || res.scan?.crs || "TWD97 (121) + TWVD2001")}</b></div>
              <div>Geometry: <b>${(res.total_vertices || 0).toLocaleString()} verts · ${(res.total_faces || 0).toLocaleString()} faces</b></div>
              <div>Stream Size: <b>${outMb} MB</b></div>
              ${
                archivedCount > 0
                  ? `<div style="margin-top:5px;padding-top:5px;border-top:1px solid var(--ui-border);display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--ui-text-secondary);">
                       <span>🗑️ <b>${archivedCount}</b> source scan backup${archivedCount === 1 ? "" : "s"} moved to Trash Bin</span>
                       <button type="button" class="gs-top-btn" id="btnMergeResultOpenBin" style="padding:2px 7px;font-size:10.5px;">Open Trash Bin</button>
                     </div>`
                  : ""
              }
            </div>
          `;
          document.getElementById("btnMergeResultOpenBin")?.addEventListener("click", () => {
            openRecycleBinModal();
          });
        }
        showToast(
          `Merged ${res.merged_count} scans into "${mergedName}"${
            Number(res.archived_to_bin_count) > 0 ? " · Source backups in Trash Bin" : ""
          }!`
        );
      } catch (err) {
        if (resBox) {
          resBox.innerHTML = `<div style="padding:8px;border-radius:6px;background:rgba(239,68,68,0.12);color:#ef4444;font-size:11.5px;">Merge failed: ${err.message}</div>`;
        }
        showToast(`Merge Error: ${err.message}`);
      }
    });

    // Post-merge quick workflow launchers
    document.getElementById("btnPostMergeOptimize")?.addEventListener("click", () => {
      setActiveStudioTool("optimizer");
      openOptimizerInspector();
    });
    document.getElementById("btnPostMergeVolume")?.addEventListener("click", () => {
      setActiveStudioTool("volume");
      openCutFillVolumeInspector();
    });
    document.getElementById("btnPostMergeContours")?.addEventListener("click", () => {
      setActiveStudioTool("contours");
      openContoursInspector();
    });
    document.getElementById("btnPostMergeSection")?.addEventListener("click", () => {
      setActiveStudioTool("section");
      openSectionBoxInspector();
    });
  }

  function openAlignMergeInspector() {
    STATE.sidePanelMinimized = false;
    if (!STATE.multiAlign.active) {
      STATE.multiAlign.lastMergedScan = null;
      enterMultiScanAlignMode();
    } else {
      updateStudioTransformGizmo();
    }
    renderAlignMergeInspectorContent();
  }

  // Unified Bottom Dock (#bimBottomDock) + Separate Left-Side Scan Editing Dock (#studioEditingDock) Button Wiring
  document.querySelectorAll("#bimBottomDock .bim-dock-btn, #studioEditingDock .bim-dock-btn").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      if (btn.id === "btnClearMeasurements" || btn.id === "btnMeasureClear") {
        clearMeasurements();
        if (studioThree && studioThree.contourGroup) {
          while (studioThree.contourGroup.children.length > 0) {
            studioThree.contourGroup.remove(studioThree.contourGroup.children[0]);
          }
        }
        showToast("Cleared 3D measurements & overlays");
        return;
      }

      const tool = btn.dataset.tool || btn.dataset.dock || "";
      if (STATE.multiAlign?.active && (MULTI_ALIGN_DISABLED_TOOLS.has(tool) || btn.classList.contains("multi-align-disabled"))) {
        ev.preventDefault();
        showToast("Unavailable during Multi-Scan Editing — merge scans first (or exit Multi-Scan mode)");
        return;
      }
      if (tool === "snap") {
        STATE.snapEnabled = !STATE.snapEnabled;
        btn.classList.toggle("active", STATE.snapEnabled);
        showToast(`Snapping ${STATE.snapEnabled ? "Enabled" : "Disabled"}`);
        return;
      }
      if (tool === "first_person" || btn.id === "btnToggleFirstPerson") {
        toggleFirstPersonMode();
        return;
      }
      if (!tool) return;

      // Clicking an already-active Lasso dock button pauses Lasso cleanly WITHOUT discarding selected polygons
      if ((tool === "crop_delete" && STATE.activeTool === "crop_delete") || (tool === "crop" && STATE.activeTool === "crop")) {
        cancelLassoToolMode(true, false);
        showToast("Lasso paused (orbit mode) — selected polygons preserved");
        return;
      }

      if (tool === "optimizer") {
        preserveLassoSelectionBeforeToolSwitch();
        setActiveStudioTool("optimizer");
        openMeshCompressionInspector();
        return;
      }

      if (tool === "crs") {
        preserveLassoSelectionBeforeToolSwitch();
        setActiveStudioTool("crs");
        openCoordinateSystemInspector();
        return;
      }

      if (tool === "generate_scan") {
        preserveLassoSelectionBeforeToolSwitch();
        setActiveStudioTool("generate_scan");
        openGenerateScanInspector();
        return;
      }

      preserveLassoSelectionBeforeToolSwitch();
      setActiveStudioTool(tool);
      STATE.measurePoints = [];

      if (tool === "volume") openCutFillVolumeInspector();
      else if (tool === "contours") openContoursInspector();
      else if (tool === "profile") openProfileInspector();
      else if (tool === "section") openSectionBoxInspector();
      else if (tool === "photos") openRtkPhotoInspector();
      else if (tool === "categorize") openCategorizeInspector();
      else if (tool === "comments") openCommentsInspector();
      else if (tool === "crop_delete") {
        STATE.cropMode = "delete_inside";
        openLassoDeleteInspector({ armLasso: true });
        showToast(
          window.innerWidth <= 768
            ? "✏️ 套索刪除已啟用 — 單指畫圈標記，雙指縮放平移，點擊上方 🔄 切換旋轉"
            : "Lasso active (Mark for Deletion) — mark multiple regions, Mouse Wheel to rotate, then press Delete"
        );
      } else if (tool === "crop") {
        STATE.cropMode = "keep_inside";
        openLassoKeepInspector({ armLasso: true });
        showToast(
          window.innerWidth <= 768
            ? "✂️ 框選保留已啟用 — 單指畫圈標記保留區，雙指縮放平移，點擊上方 🔄 切換旋轉"
            : "Lasso active (Keep Inside) — mark keep boundary, Mouse Wheel to rotate, Esc to cancel"
        );
      } else if (tool === "align_merge") {
        openAlignMergeInspector();
      }
      if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
    });
  });

  // First-Person Camera Top Bar & HUD Controls + PointerLock Listeners
  document.getElementById("btnStudioFirstPerson")?.addEventListener("click", () => {
    toggleFirstPersonMode();
  });
  document.getElementById("btnExitFirstPerson")?.addEventListener("click", () => {
    exitFirstPersonMode(false);
  });
  document.getElementById("btnFpPointerLock")?.addEventListener("click", () => {
    if (document.pointerLockElement) {
      try {
        document.exitPointerLock();
      } catch (_) {}
    } else {
      requestStudioPointerLock();
    }
  });
  document.getElementById("btnFpModeFly")?.addEventListener("click", () => {
    setFirstPersonLocomotion("fly", true);
  });
  document.getElementById("btnFpModeWalk")?.addEventListener("click", () => {
    setFirstPersonLocomotion("walk", true);
  });
  document.getElementById("fpSpeedSlider")?.addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v >= 0.5) {
      STATE.fpMode.baseSpeed = v;
      syncFirstPersonHudUI();
    }
  });

  // Mobile / Tablet Touch D-Pad for First-Person Navigation (supports continuous thumb sliding across buttons)
  const fpTouchMovePadEl = document.getElementById("fpTouchMovePad");
  if (fpTouchMovePadEl) {
    let activePadPointerId = null;
    let activePadKey = null;
    const clearPadKey = () => {
      if (activePadKey && STATE.fpMode.keys) {
        delete STATE.fpMode.keys[activePadKey];
      }
      activePadKey = null;
      fpTouchMovePadEl.querySelectorAll("[data-fp-key].active").forEach((el) => el.classList.remove("active"));
    };
    const updatePadFromPoint = (clientX, clientY) => {
      if (!STATE.fpMode.active) {
        clearPadKey();
        return;
      }
      const hitBtn = document.elementFromPoint(clientX, clientY)?.closest?.("#fpTouchMovePad [data-fp-key]");
      const nextCode = hitBtn ? hitBtn.getAttribute("data-fp-key") : null;
      if (nextCode === activePadKey) return;
      clearPadKey();
      if (nextCode && hitBtn) {
        activePadKey = nextCode;
        STATE.fpMode.keys[nextCode] = true;
        hitBtn.classList.add("active");
      }
    };
    fpTouchMovePadEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      activePadPointerId = e.pointerId;
      try {
        fpTouchMovePadEl.setPointerCapture(e.pointerId);
      } catch (_) {}
      updatePadFromPoint(e.clientX, e.clientY);
    });
    fpTouchMovePadEl.addEventListener("pointermove", (e) => {
      if (activePadPointerId === null || e.pointerId !== activePadPointerId) return;
      e.preventDefault();
      e.stopPropagation();
      updatePadFromPoint(e.clientX, e.clientY);
    });
    const endPadGesture = (e) => {
      if (activePadPointerId !== null && e.pointerId !== activePadPointerId) return;
      e.stopPropagation();
      activePadPointerId = null;
      clearPadKey();
    };
    fpTouchMovePadEl.addEventListener("pointerup", endPadGesture);
    fpTouchMovePadEl.addEventListener("pointercancel", endPadGesture);
  }

  document.addEventListener("pointerlockchange", () => {
    syncStudioControlsForTool();
    syncFirstPersonHudUI();
  });

  document.addEventListener("mousemove", (e) => {
    if (!STATE.fpMode.active || STATE.activeView !== "studio") return;
    const domEl = studioThree?.renderer?.domElement;
    if (!domEl || document.pointerLockElement !== domEl) return;
    const mx = Number(e.movementX) || 0;
    const my = Number(e.movementY) || 0;
    if (mx !== 0 || my !== 0) {
      applyFirstPersonLookDelta(mx, my, 0.0021);
    }
  });

  window.addEventListener("keyup", (e) => {
    if (STATE.fpMode.keys && e.code) {
      delete STATE.fpMode.keys[e.code];
      if (e.code === "ShiftLeft" || e.code === "ShiftRight" || e.code === "AltLeft" || e.code === "AltRight") {
        syncFirstPersonHudUI();
      }
    }
  });

  window.addEventListener("blur", () => {
    if (STATE.fpMode) {
      STATE.fpMode.keys = Object.create(null);
      STATE.fpMode.dragLooking = false;
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && STATE.fpMode) {
      STATE.fpMode.keys = Object.create(null);
      STATE.fpMode.dragLooking = false;
    }
  });

  // Keyboard shortcuts for First-Person WASD, Esc (cancel active lasso / measurement / FP or close top modal), Enter (lock active polygon), and W/E/R/L in Align & Merge mode
  window.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;

    if ((e.ctrlKey || e.metaKey) && STATE.fpMode?.keys) {
      STATE.fpMode.keys = Object.create(null);
    }

    const hasOpenModal = document.querySelectorAll(".gs-modal-backdrop.active").length > 0;

    // Toggle First-Person Mode anytime in Studio with 'F' (without Ctrl/Meta/Alt)
    if (STATE.activeView === "studio" && !hasOpenModal && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === "KeyF") {
      e.preventDefault();
      toggleFirstPersonMode();
      return;
    }

    // Active First-Person Video-Game Movement & Mode Controls (takes priority over Gizmo W/E!)
    if (STATE.activeView === "studio" && !hasOpenModal && STATE.fpMode.active) {
      if (!e.ctrlKey && !e.metaKey && e.code === "KeyG") {
        e.preventDefault();
        setFirstPersonLocomotion(STATE.fpMode.locomotion === "walk" ? "fly" : "walk", true);
        return;
      }
      if (!e.ctrlKey && !e.metaKey && FP_MOVEMENT_CODES.has(e.code)) {
        e.preventDefault();
        STATE.fpMode.keys[e.code] = true;
        if (e.code === "ShiftLeft" || e.code === "ShiftRight" || e.code === "AltLeft" || e.code === "AltRight") {
          syncFirstPersonHudUI();
        }
        return;
      }
    }

    if (
      STATE.activeView === "studio" &&
      !hasOpenModal &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      STATE.multiAlign.active &&
      STATE.activeTool === "align_merge"
    ) {
      const k = e.key.toLowerCase();
      if (k === "w") {
        STATE.multiAlign.gizmoMode = "translate";
        updateStudioTransformGizmo();
        renderAlignMergeInspectorContent();
        showToast("Gizmo Mode: Move (W)");
        return;
      } else if (k === "e") {
        STATE.multiAlign.gizmoMode = "rotate";
        updateStudioTransformGizmo();
        renderAlignMergeInspectorContent();
        showToast("Gizmo Mode: Rotate (E)");
        return;
      } else if (k === "r") {
        STATE.multiAlign.gizmoMode = "both";
        updateStudioTransformGizmo();
        renderAlignMergeInspectorContent();
        showToast("Gizmo Mode: Move + Rotate (R)");
        return;
      } else if (k === "l") {
        const sel = getSelectedMultiAlignLayer();
        if (sel) {
          sel.locked = !sel.locked;
          updateStudioTransformGizmo();
          renderAlignMergeInspectorContent();
          showToast(sel.locked ? `Locked "${sel.name}" 🔒` : `Unlocked "${sel.name}" 🔓`);
          return;
        }
      }
    }

    if (e.key === "Escape") {
      if (document.getElementById("gsStudioQuickSharePopover")) {
        closeQuickSingleScanSharePopover();
        return;
      }
      if (document.getElementById("gsDownloadFormatPopover") && typeof closeDownloadFormatMenu === "function") {
        closeDownloadFormatMenu();
        return;
      }
      // 1. If a non-locked modal is open, close the topmost open modal
      const openModals = Array.from(document.querySelectorAll(".gs-modal-backdrop.active"));
      if (openModals.length > 0) {
        const topModal = openModals[openModals.length - 1];
        if (topModal.id !== "userProfileGateModal" || STATE.isAuthorized || STATE.shareToken) {
          closeModal(topModal.id);
          return;
        }
      }
      // 2. Pause Lasso on Esc (if mid-drag, cancel only the in-progress drag; if armed, switch to orbit mode while keeping all selected polygons!)
      if (STATE.activeView === "studio") {
        const isDraggingLasso = Boolean(studioThree && typeof studioThree._isLassoDragging === "function" && studioThree._isLassoDragging());
        if (isDraggingLasso) {
          e.preventDefault();
          if (typeof studioThree._cancelLassoDrag === "function") studioThree._cancelLassoDrag();
          showToast("Cancelled current Lasso drag (Esc) — previous polygons preserved");
          return;
        }
        if (STATE.activeTool === "crop_delete" || STATE.activeTool === "crop") {
          e.preventDefault();
          cancelLassoToolMode(true, false);
          showToast("Lasso paused (Esc) — selected polygons preserved");
          return;
        }
      }
      // 3. Otherwise cancel any in-progress measurement points, active Categorize edit mode, active Studio tool / side panel, or First-Person mode
      if (
        STATE.activeView === "studio" &&
        STATE.activeTool === "categorize" &&
        (STATE.categorizeEditMode || (Array.isArray(STATE.categorizeEditPoints) && STATE.categorizeEditPoints.length > 0))
      ) {
        STATE.categorizeEditMode = null;
        STATE.categorizeEditPoints = [];
        clearTempDistanceVisuals();
        if (STATE.lastCategorizeResult && document.getElementById("catResultContainer")) {
          renderCategorizePanelContent(STATE.lastCategorizeResult);
        }
        showToast("已取消手動編輯模式 (Cancelled manual edit mode)");
        return;
      }
      if (STATE.activeView === "studio" && STATE.measurePoints.length > 0) {
        STATE.measurePoints = [];
        clearTempDistanceVisuals();
        if (studioThree && studioThree.polyPreviewGroup) {
          while (studioThree.polyPreviewGroup.children.length > 0) {
            studioThree.polyPreviewGroup.remove(studioThree.polyPreviewGroup.children[0]);
          }
        }
        if (STATE.activeTool === "volume" && !STATE.polygonLocked) {
          clearVolumeVisualsOnly();
          openCutFillVolumeInspector(null);
        }
        showToast("Cancelled in-progress points (Esc)");
      } else if (
        STATE.activeView === "studio" &&
        [
          "laser",
          "coordinates",
          "angle",
          "distance",
          "area",
          "volume",
          "contours",
          "profile",
          "section",
          "photos",
          "rtk",
          "categorize",
          "comments",
          "optimizer",
          "crs",
          "generate_scan",
        ].includes(STATE.activeTool)
      ) {
        if (STATE.activeTool === "section") {
          clearSectionBoxClippingIfNotKept();
        }
        if (STATE.activeTool === "categorize") {
          clearCategorizeVisualsOnly();
        }
        document.getElementById("studioSidePanel")?.classList.remove("active");
        setActiveStudioTool(STATE.multiAlign?.active ? "align_merge" : "orbit");
        showToast("Exited active tool (Esc)");
      } else if (STATE.activeView === "studio" && document.getElementById("studioSidePanel")?.classList.contains("active")) {
        document.getElementById("studioSidePanel")?.classList.remove("active");
      } else if (STATE.activeView === "studio" && STATE.fpMode?.active) {
        exitFirstPersonMode(false);
      }
    } else if (
      e.key === "Enter" &&
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
      } else if (STATE.categorizeEditMode === "add_wall" && STATE.categorizeEditPoints.length >= 2) {
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
      }
    } else if (e.key === "Enter" && STATE.activeView === "studio" && STATE.measurePoints.length >= 3) {
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
        STATE.maskBoundaryPoints = lockedPts.map((p) => p.clone());
        showToast(`Area polygon locked (${lockedPts.length} vertices)`);
      }
    }
  });

  document.getElementById("btnOpenOptimizer")?.addEventListener("click", () => {
    if (STATE.activeView !== "studio") switchView("studio", STATE.activeScanId);
    setActiveStudioTool("optimizer");
    openMeshCompressionInspector();
  });

  document.getElementById("btnStudioDownloadObj")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (STATE.multiAlign?.active) {
      showToast("Unavailable during Multi-Scan Editing — merge scans first to download unified mesh");
      return;
    }
    const dlBtn = document.getElementById("btnStudioDownloadObj");
    const activeScan =
      STATE.activeScan || STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || null;
    if (dlBtn && activeScan) {
      openDownloadFormatMenu(dlBtn, activeScan);
    }
  });

  document.getElementById("btnStudioSurveyReport")?.addEventListener("click", (ev) => {
    if (STATE.multiAlign?.active) {
      ev.preventDefault();
      showToast("Unavailable during Multi-Scan Editing — merge scans first to generate a Survey Report");
      return;
    }
    if (STATE.activeView !== "studio") switchView("studio", STATE.activeScanId);
    openContoursInspector();
  });

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

  function alignCompareSides() {
    if (!compareCtx) return;
    const left = compareCtx.left;
    const right = compareCtx.right;
    const lInfo = classifyCompareSideCoords(left);
    const rInfo = classifyCompareSideCoords(right);

    // Choose a single shared TWD97 reference anchor so both scans lock 1:1 in world space.
    // Prefer the scan with the tighter bounding radius so the camera orbits the overlapping core site area.
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
    }

    [
      [left, lInfo],
      [right, rInfo],
    ].forEach(([side, info]) => {
      if (!side || !info) return;
      const rootObj = side.tilesRenderer?.group || side.loadedMesh;
      if (!rootObj) return;
      // 1. Center raw tileset/mesh vertices on rawCenter for 32-bit float precision
      rootObj.position.set(-info.rawCenter.x, -info.rawCenter.y, -info.rawCenter.z);
      rootObj.updateMatrix();

      // 2. Apply exact Multi-Scan co-registration (when comparing source vs merged) or CRS alignment offset
      if (mergedLink && mergedLink.compSide === side && sharedAnchor) {
        const deltaRaw = info.rawCenter.clone().sub(mergedLink.nativeAnchor).applyMatrix4(mergedLink.mat4Zup);
        const tAlign = mergedLink.mergedAnchor.clone().sub(sharedAnchor).add(deltaRaw);
        side.alignGroup.position.copy(tAlign);
        side.alignGroup.quaternion.copy(mergedLink.qZup);
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
    if (left?.grid) left.grid.position.y = groundY;
    if (right?.grid) right.grid.position.y = groundY;

    // Auto-frame camera when a new scan pair finishes loading tilesets
    const pairKey = `${left._loadedScanId || ""}|${right._loadedScanId || ""}`;
    if (lInfo && rInfo && compareCtx._framedPairKey !== pairKey) {
      compareCtx._framedPairKey = pairKey;
      frameCompareCamera(false);
    }
  }

  function frameCompareCamera(showMsg = false) {
    if (!compareCtx) return;
    const { left, right, controls } = compareCtx;
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
    right.camera.position.copy(left.camera.position);
    right.camera.quaternion.copy(left.camera.quaternion);
    right.camera.updateProjectionMatrix();
    right.camera.updateMatrixWorld();
    if (showMsg) {
      showToast("Reset & Synced Compare Camera Framing");
    }
  }

  function setCompareMode(mode) {
    const resolvedMode = mode === "split" ? "split" : "slider";
    STATE.compareMode = resolvedMode;
    const stage = document.getElementById("compareStage");
    const rightContainer = document.getElementById("compareRightLayer");
    const divider = document.getElementById("curtainDivider");
    const lblPct = document.getElementById("lblCurtainPct");
    const pct = (compareCtx && compareCtx._curtainPct) || 50;

    if (stage) {
      stage.classList.toggle("mode-split", resolvedMode === "split");
    }
    if (rightContainer) {
      rightContainer.style.clipPath = resolvedMode === "split" ? "none" : `inset(0 0 0 ${pct}%)`;
    }
    if (divider) {
      divider.style.display = resolvedMode === "split" ? "none" : "";
    }
    if (lblPct) {
      lblPct.style.display = resolvedMode === "split" ? "none" : "";
      lblPct.textContent = `Split: ${Math.round(pct)}%`;
    }
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
    applyCompareElevationHeatmapToSide(compareCtx.left, active);
    applyCompareElevationHeatmapToSide(compareCtx.right, active);
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
    const lSel = document.getElementById("compareLeftSelect");
    const rSel = document.getElementById("compareRightSelect");
    const leftId = lSel?.value || STATE.scans[Math.min(1, STATE.scans.length - 1)]?.scan_id;
    const rightId = rSel?.value || STATE.scans[0]?.scan_id;
    if (leftId) loadScanIntoCompareSide(compareCtx.left, leftId);
    if (rightId) loadScanIntoCompareSide(compareCtx.right, rightId);
    alignCompareSides();
  }

  function syncCompareLoaderProgress() {
    if (!compareCtx || compareCtx._loadingDone) return;
    const lSide = compareCtx.left;
    const rSide = compareCtx.right;
    const lStats = lSide?.tilesRenderer?.stats || {};
    const rStats = rSide?.tilesRenderer?.stats || {};
    const lReady = Boolean(lSide?._glbLoaded || lSide?._fallbackLoaded || Number(lStats.loaded || 0) > 0);
    const rReady = Boolean(rSide?._glbLoaded || rSide?._fallbackLoaded || Number(rStats.loaded || 0) > 0);
    const loaded =
      Number(lStats.loaded || 0) +
      Number(rStats.loaded || 0) +
      (lSide?._glbLoaded ? 1 : 0) +
      (rSide?._glbLoaded ? 1 : 0);
    const activeWork =
      Number(lStats.downloading || 0) +
      Number(lStats.parsing || 0) +
      Number(rStats.downloading || 0) +
      Number(rStats.parsing || 0);
    const queued = Number(lStats.queued || 0) + Number(rStats.queued || 0);
    const pending = activeWork + queued;
    const total = Math.max(1, loaded + pending);
    const now = performance.now();
    const elapsed = now - (compareCtx._loadingStartMs || 0);
    const sinceTileset = compareCtx._tilesetReadyMs ? now - compareCtx._tilesetReadyMs : 0;

    const bothSidesHaveMesh =
      lReady &&
      rReady &&
      (pending === 0 || (activeWork === 0 && sinceTileset > 900) || loaded >= Math.max(2, Math.ceil(total * 0.75)));

    if (bothSidesHaveMesh && elapsed > 180) {
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
      if (lbl) lbl.textContent = `Split: ${Math.round(pct)}%`;
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

    // Compare Mode Switcher (Slider Mode vs 2-Viewport Synced Camera Mode)
    document.querySelectorAll("#compareModeSwitcher .btn-seg").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.compareMode || "slider";
        setCompareMode(mode);
        showToast(
          mode === "split"
            ? "2-Viewport Mode: Full Side-by-Side Scans with Synced Camera"
            : "Slider Mode: Interactive Split Curtain Comparison"
        );
      });
    });

    document.getElementById("btnCompareResetCamera")?.addEventListener("click", () => {
      frameCompareCamera(true);
    });

    // Left / Right Scan Dropdown Listeners
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
      right.camera.position.copy(left.camera.position);
      right.camera.quaternion.copy(left.camera.quaternion);
      right.camera.updateMatrixWorld();
      const heatmapOn = Boolean(document.getElementById("chkDeltaZHeatmap")?.checked);
      [left, right].forEach((side) => {
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
      syncCompareLoaderProgress();
      left.renderer.render(left.scene, left.camera);
      right.renderer.render(right.scene, right.camera);
    };
    requestAnimationFrame(loop);

    compareCtx = { left, right, controls, _curtainPct: 50, _framedPairKey: "" };
    window.__gsCompareCtx = compareCtx;
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
      if (compareCtx.left?.scene) compareCtx.left.scene.background = new THREE.Color(cmpLeftHex);
      if (compareCtx.right?.scene) compareCtx.right.scene.background = new THREE.Color(cmpRightHex);
      [compareCtx.left, compareCtx.right].forEach((side) => {
        if (side?.grid && side.grid.material) {
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
        subEl.textContent = `Auto by Time of Day (${nowStr} → Currently ${resolved === "dark" ? "Dark" : "Light"} · 06:00–18:00 Light)`;
      } else if (normalizedPref === "light") {
        subEl.textContent = "Locked to Light Theme across all views & 3D canvases";
      } else {
        subEl.textContent = "Locked to Dark Theme across all views & 3D canvases";
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
          if (tEl) tEl.textContent = `Active PIX4Dmatic Pipeline: ${lp.scan_name} (${Math.round(lp.progress_pct || 0)}%)`;
          const bEl = document.getElementById("livePix4dStageBadge");
          if (bEl) bEl.textContent = `${lp.stage}${lp.cpu_ram ? " · " + lp.cpu_ram : ""}`;
          const pBar = document.getElementById("livePix4dProgressBar");
          if (pBar) pBar.style.width = `${Math.max(5, Math.min(100, Number(lp.progress_pct || 10)))}%`;
          const pathEl = document.getElementById("livePix4dLogPath");
          if (pathEl) pathEl.textContent = `Log: ${lp.log_path || ""}`;
          const tailEl = document.getElementById("livePix4dLogTail");
          if (tailEl) tailEl.textContent = (lp.tail_lines || []).join("\n");
        } else {
          monBox.style.display = "none";
        }
      }

      const rows = Array.isArray(qData.all_scans) && qData.all_scans.length > 0 ? qData.all_scans : STATE.scans;
      tbody.innerHTML = "";
      rows.forEach((s) => {
        const tr = document.createElement("tr");
        const isProc = s.status === "processing";
        const pct = Math.round(Number(s.progress_pct || (s.status === "completed" ? 100 : 0)));
        const safeStatus = escapeHtml(String(s.status || "").toUpperCase());
        const safeStage = escapeHtml(s.stage_label || "Running PIX4Dmatic...");
        const statusHtml = isProc
          ? `<div style="display:flex;flex-direction:column;gap:3px;min-width:130px;">
               <span class="gs-crs-pill" style="background:rgba(2,132,199,0.18);color:var(--ui-accent);">PROCESSING (${pct}%)</span>
               <div style="height:4px;background:var(--ui-border-strong);border-radius:999px;overflow:hidden;">
                 <div style="height:100%;width:${Math.max(5, pct)}%;background:var(--ui-accent);"></div>
               </div>
               <span style="font-size:10px;color:var(--ui-text-secondary);">${safeStage}</span>
             </div>`
          : `<span class="gs-crs-pill">${safeStatus}</span>`;

        const safeScanId = escapeHtml(s.scan_id || "");
        tr.innerHTML = `
          <td><b style="color:var(--ui-text-primary);">${escapeHtml(s.name || s.scan_id || "")}</b><br><span style="font-size:10.5px;color:var(--ui-text-muted);">${safeScanId}</span></td>
          <td style="color:var(--ui-text-secondary);">${escapeHtml(s.project_group || "")}</td>
          <td><span style="color:var(--ui-text-primary);font-weight:600;">${escapeHtml(s.uploader_name || "")}</span><br><span style="font-size:10.5px;color:var(--ui-text-muted);">${escapeHtml(s.uploader_email || "")} · ${escapeHtml(s.capture_date || "")}</span></td>
          <td><span style="color:var(--ui-text-primary);font-weight:600;">${Number(s.image_count || 0)} imgs</span><br><span style="font-size:10.5px;color:var(--ui-text-muted);">${escapeHtml(formatCoveredAreaM2(s))} · ${Number(s.size_mb || (s.size_bytes || 0) / 1048576).toFixed(1)} MB</span></td>
          <td><span class="gs-crs-pill">${escapeHtml(getScanCrsDisplayLabel(s))} · ${Number(s.texture_resolution || 4096)}px</span></td>
          <td style="font-family:monospace;font-weight:700;color:var(--ui-text-primary);">${escapeHtml(String(s.priority_score ?? ""))}</td>
          <td>${statusHtml}</td>
          <td style="display:flex;gap:4px;">
            <button type="button" class="btn-xs" data-gst="${safeScanId}" title="Preview .GST Script">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
              </svg>
            </button>
            <button type="button" class="btn-xs" data-reprocess="${safeScanId}" title="Re-run from Original Photos with Custom PIX4Dmatic Settings">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
            </button>
          </td>
        `;
        tr.querySelector("[data-gst]")?.addEventListener("click", () => previewGstForScan(s.scan_id));
        tr.querySelector("[data-reprocess]")?.addEventListener("click", () => {
          openRerunScanModal(s.scan_id);
        });
        tbody.appendChild(tr);
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
      tbody.innerHTML = `<tr><td colspan="8" style="color:var(--ui-text-muted);">Loading...</td></tr>`;
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
        const authTag = st.auth_configured ? " · Auth Ready" : " · Link/OAuth";
        badge.textContent = `${synced} / ${total} .3tz Synced (${st.total_size_mb || 0} MB)${authTag}`;
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

  // 5B. Scoped External Sharing Modal (Requirement 4.b)
  function getPublicShareOrigin() {
    const loc = window.location;
    const host = String(loc.hostname || "").toLowerCase();
    const isLocalOrPrivate =
      !host ||
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
    if (isLocalOrPrivate) {
      return "https://scans.gatheren.cloud";
    }
    return loc.origin;
  }

  function buildPublicShareUrl(token) {
    const cleanTok = encodeURIComponent(String(token || "").trim());
    return `${getPublicShareOrigin()}/s/${cleanTok}`;
  }

  function resolveShareScopeTitle(scopeType, targetId) {
    const st = String(scopeType || "scan").toLowerCase();
    const tid = String(targetId || "");
    if (st === "scan") {
      const matched = (STATE.scans || []).find((s) => s.scan_id === tid);
      if (matched && matched.name) {
        return matched.name;
      }
    }
    return tid;
  }

  async function copyTextToClipboard(text) {
    const str = String(text || "");
    if (!str) return false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(str);
        return true;
      } catch (_) {}
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = str;
      ta.setAttribute("readonly", "readonly");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.left = "-9999px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, str.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return Boolean(ok);
    } catch (_) {
      return false;
    }
  }

  function flashCopyButtonState(btnEl) {
    if (!btnEl) return;
    if (!btnEl.dataset.origHtml) {
      btnEl.dataset.origHtml = btnEl.innerHTML;
    }
    btnEl.classList.add("is-copied");
    btnEl.innerHTML = `
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      <span>Copied!</span>
    `;
    if (btnEl._copyTimer) clearTimeout(btnEl._copyTimer);
    btnEl._copyTimer = setTimeout(() => {
      btnEl.classList.remove("is-copied");
      if (btnEl.dataset.origHtml) {
        btnEl.innerHTML = btnEl.dataset.origHtml;
      }
    }, 2200);
  }

  function showLatestShareLinkBanner(url, statusLabel = "Shareable Link Ready:") {
    const bar = document.getElementById("shareLatestCreatedBar");
    const inp = document.getElementById("shareLatestUrlInput");
    const openBtn = document.getElementById("btnOpenLatestShareUrl");
    const lbl = document.getElementById("shareLatestLabelText");
    if (!bar || !inp) return;
    if (!url) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "flex";
    inp.value = url;
    if (openBtn) openBtn.href = url;
    if (lbl) lbl.textContent = statusLabel;
  }

  let _cachedShareLinksList = [];

  function syncBannerWithSelectedTarget() {
    const scopeSel = document.getElementById("shareScopeType");
    const targetSel = document.getElementById("shareTargetId");
    const st = scopeSel?.value || "scan";
    const tid = targetSel?.value || "";
    const activeMatch =
      _cachedShareLinksList.find((l) => !l.revoked && l.scope_type === st && l.target_id === tid) ||
      _cachedShareLinksList.find((l) => !l.revoked);
    if (activeMatch && activeMatch.token) {
      showLatestShareLinkBanner(buildPublicShareUrl(activeMatch.token), "Shareable Link Ready:");
    } else {
      showLatestShareLinkBanner("");
    }
  }

  document.getElementById("shareLatestUrlInput")?.addEventListener("click", (e) => {
    e.currentTarget?.select?.();
  });
  document.getElementById("btnCopyLatestShareUrl")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const inp = document.getElementById("shareLatestUrlInput");
    const url = inp?.value || "";
    if (!url) return;
    await copyTextToClipboard(url);
    inp?.select?.();
    flashCopyButtonState(btn);
    showToast(`Copied share link: ${url}`);
  });

  function formatDurationCompact(secRaw) {
    const s = Math.max(0, Math.round(Number(secRaw || 0)));
    if (s <= 0) return "0s";
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const remS = s % 60;
    if (m < 60) return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
  }

  const SHARE_TOOL_LABELS = {
    orbit: "3D Orbit / Zoom",
    first_person_fly: "First-Person Fly",
    first_person_walk: "First-Person Walk",
    comments: "Comments Tool",
    comment_posted: "Posted Comment",
    distance: "Distance",
    area: "Polygon Area",
    coordinates: "Coordinates",
    angle: "3D Angle",
    laser: "Laser Span",
    volume: "Cut/Fill Volume",
    contours: "Elevation Contours",
    profile: "Cross-Section Profile",
    section: "Section Box",
    photos: "RTK Camera Poses",
    compare_slider: "Multi-Date Compare",
    download_3tz: "Download .3TZ",
    download_glb: "Download .GLB",
    download_obj: "Download .OBJ",
    download_zip: "Download .ZIP",
  };

  function formatToolNameFriendly(rawKey) {
    const k = String(rawKey || "").trim();
    if (!k) return "Tool";
    if (SHARE_TOOL_LABELS[k]) return SHARE_TOOL_LABELS[k];
    if (k.startsWith("download_")) return `Download .${k.slice(9).toUpperCase()}`;
    return k
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  let _activeAnalyticsToken = "";

  function closeShareAnalyticsDrawer() {
    _activeAnalyticsToken = "";
    const drawer = document.getElementById("shareAnalyticsDrawer");
    if (drawer) drawer.style.display = "none";
  }

  async function openShareAnalyticsDrawer(token) {
    const cleanTok = String(token || "").trim();
    if (!cleanTok) return;
    _activeAnalyticsToken = cleanTok;
    const drawer = document.getElementById("shareAnalyticsDrawer");
    const titleEl = document.getElementById("lblShareAnalyticsTitle");
    const subEl = document.getElementById("lblShareAnalyticsSub");
    const kpiGrid = document.getElementById("shareAnalyticsKpiGrid");
    const listBox = document.getElementById("shareAnalyticsSessionsList");
    if (!drawer || !kpiGrid || !listBox) return;

    drawer.style.display = "flex";
    kpiGrid.innerHTML = "";
    listBox.innerHTML = `<div style="font-size:11.5px;color:var(--ui-text-muted);padding:8px 2px;">Loading visitor telemetry &amp; tool engagement...</div>`;

    try {
      const res = await apiGet(`/api/share/analytics?token=${encodeURIComponent(cleanTok)}&limit=150`);
      if (_activeAnalyticsToken !== cleanTok) return;
      const link = res.link || {};
      const summary = res.summary || {};
      const sessions = Array.isArray(res.sessions) ? res.sessions : [];

      const scopeKind = String(link.scope_type || "scan").toUpperCase();
      const friendlyTarget = link.target_id ? resolveShareScopeTitle(link.scope_type, link.target_id) : cleanTok;
      if (titleEl) {
        titleEl.textContent = `${link.label || friendlyTarget} — Visitor & Tool Analytics`;
      }
      if (subEl) {
        const lastStr = summary.last_viewed_at ? `Last viewed: ${summary.last_viewed_at}` : "No human sessions recorded yet";
        subEl.textContent = `${scopeKind}: ${friendlyTarget} · Created ${link.created_at || "—"} · ${lastStr}`;
      }

      const humanOpens = Math.max(Number(link.human_views ?? link.view_count ?? 0), Number(summary.recorded_sessions || 0));
      const topTools = Array.isArray(summary.top_tools) ? summary.top_tools : [];
      const topToolFirst = topTools[0] || null;
      const topToolLabel = topToolFirst ? formatToolNameFriendly(topToolFirst.tool) : "—";
      const topToolSub = topToolFirst
        ? `${topToolFirst.seconds >= 1 ? formatDurationCompact(topToolFirst.seconds) + " engaged · " : ""}${topToolFirst.uses || 1}x across ${topToolFirst.sessions || 1} session(s)`
        : "Waiting for tool activity";

      const totalActions =
        Number(summary.measurements_total || 0) +
        Number(summary.comments_posted_total || 0) +
        Number(summary.downloads_total || 0);

      kpiGrid.innerHTML = `
        <div class="gs-analytics-kpi-card">
          <div class="k-lbl">Human Opens</div>
          <div class="k-val">${humanOpens}</div>
          <div class="k-sub">${Number(summary.recorded_sessions || 0)} tracked session(s)</div>
        </div>
        <div class="gs-analytics-kpi-card">
          <div class="k-lbl">Unique Visitors</div>
          <div class="k-val">${Number(summary.unique_visitors || 0)}</div>
          <div class="k-sub">${Number(summary.bot_unfurls || 0)} chat link preview(s)</div>
        </div>
        <div class="gs-analytics-kpi-card">
          <div class="k-lbl">Avg Active Time</div>
          <div class="k-val">${escapeHtml(formatDurationCompact(summary.avg_active_sec || 0))}</div>
          <div class="k-sub">Total engaged: ${escapeHtml(formatDurationCompact(summary.total_active_sec || 0))}</div>
        </div>
        <div class="gs-analytics-kpi-card">
          <div class="k-lbl">Total Tab Open</div>
          <div class="k-val">${escapeHtml(formatDurationCompact(summary.total_open_sec || 0))}</div>
          <div class="k-sub">Foreground + background</div>
        </div>
        <div class="gs-analytics-kpi-card">
          <div class="k-lbl">Spatial Actions</div>
          <div class="k-val">${totalActions}</div>
          <div class="k-sub">${Number(summary.comments_posted_total || 0)} cmts · ${Number(summary.measurements_total || 0)} meas · ${Number(summary.downloads_total || 0)} dl</div>
        </div>
        <div class="gs-analytics-kpi-card">
          <div class="k-lbl">Most Used Tool</div>
          <div class="k-val" style="font-size:12.5px;">${escapeHtml(topToolLabel)}</div>
          <div class="k-sub">${escapeHtml(topToolSub)}</div>
        </div>
      `;

      if (!sessions.length) {
        listBox.innerHTML = `
          <div style="font-size:11.5px;color:var(--ui-text-muted);padding:10px 12px;border:1px dashed var(--ui-border-strong);border-radius:8px;">
            No visitor sessions or link previews recorded yet for this link. Share <code>${escapeHtml(buildPublicShareUrl(cleanTok))}</code> to see live viewer telemetry (who opened it, location, device/GPU, duration, and 3D tools used).
          </div>
        `;
        return;
      }

      const nowUnixSec = Date.now() / 1000;
      listBox.innerHTML = sessions
        .map((s) => {
          const isBot = Boolean(s.is_bot);
          const locStr = s.location_label || (s.ip_address ? "Location resolving..." : "Unknown location");
          const ispStr = s.isp ? ` · ${s.isp}` : "";
          const ipStr = s.ip_address || "—";

          if (isBot) {
            return `
              <div class="gs-analytics-session-card is-bot">
                <div class="gs-analytics-session-top">
                  <div class="gs-analytics-who">
                    <span class="gs-crs-pill" style="font-size:9.5px;opacity:0.85;">LINK PREVIEW UNFURL</span>
                    <span>${escapeHtml(s.browser || "Preview Crawler")}</span>
                  </div>
                  <div class="gs-analytics-meta-row">
                    <span><b>IP:</b> ${escapeHtml(ipStr)}</span>
                    <span><b>Origin:</b> ${escapeHtml(locStr + ispStr)}</span>
                    <span><b>Time:</b> ${escapeHtml(s.started_at || "—")}</span>
                  </div>
                </div>
              </div>
            `;
          }

          const isLiveNow = Number(s.last_active_ts || 0) > 0 && nowUnixSec - Number(s.last_active_ts) < 28;
          const shortVid = String(s.visitor_id || s.session_id || "").slice(-6);
          const displayWho = s.viewer_name
            ? s.viewer_name
            : s.viewer_email
            ? s.viewer_email
            : `Visitor #${shortVid || "guest"}`;
          const emailBadge =
            s.viewer_email && s.viewer_email !== displayWho
              ? `<span style="font-size:10.5px;color:var(--ui-text-muted);font-weight:500;">(${escapeHtml(s.viewer_email)})</span>`
              : "";
          const liveBadge = isLiveNow
            ? `<span class="gs-crs-pill" style="background:rgba(16,185,129,0.16);color:#10b981;border-color:rgba(16,185,129,0.45);font-size:9.5px;">LIVE NOW</span>`
            : `<span class="gs-crs-pill" style="font-size:9.5px;">#${escapeHtml(shortVid)}</span>`;

          const loadSummary =
            Number(s.max_load_pct || 0) > 0
              ? `${Math.round(Number(s.max_load_pct))}%${Number(s.load_time_ms || 0) > 0 ? ` (${(Number(s.load_time_ms) / 1000).toFixed(1)}s)` : ""}`
              : "—";

          const deviceSummary = [s.device_type, s.os, s.browser].filter(Boolean).join(" · ") || "Browser";
          const screenSummary = [s.screen_res, s.viewport_res ? `VP ${s.viewport_res}` : ""].filter(Boolean).join(" · ");
          const localeSummary = [s.language, s.timezone].filter(Boolean).join(" · ");

          // Build tool pills sorted by engaged time then count
          const rawTools = s.tools_used && typeof s.tools_used === "object" ? s.tools_used : {};
          const toolEntries = Object.entries(rawTools)
            .map(([tk, tv]) => ({
              key: tk,
              count: typeof tv === "object" ? Number(tv.count || 1) : Number(tv || 1),
              seconds: typeof tv === "object" ? Number(tv.seconds || 0) : 0,
            }))
            .sort((a, b) => b.seconds - a.seconds || b.count - a.count);

          const scansViewed = Array.isArray(s.scans_viewed) ? s.scans_viewed : [];
          const scanPillsHtml = scansViewed
            .map((sc) => {
              const nm = typeof sc === "object" ? sc.name || sc.scan_id : String(sc);
              return `<span class="gs-analytics-tool-pill" style="border-color:var(--ui-accent);color:var(--ui-accent);">Scan: <b>${escapeHtml(nm)}</b></span>`;
            })
            .join("");

          const toolPillsHtml = toolEntries
            .map((te) => {
              const durPart = te.seconds >= 1 ? formatDurationCompact(te.seconds) : "";
              const cntPart = te.count > 1 || !durPart ? `${te.count}x` : "";
              const metaStr = [durPart, cntPart].filter(Boolean).join(" · ");
              return `<span class="gs-analytics-tool-pill">${escapeHtml(formatToolNameFriendly(te.key))}${metaStr ? ` <b>${escapeHtml(metaStr)}</b>` : ""}</span>`;
            })
            .join("");

          const extraActionPills = [
            Number(s.camera_interactions || 0) > 0
              ? `<span class="gs-analytics-tool-pill">Camera Moves <b>${Number(s.camera_interactions)}</b></span>`
              : "",
            Number(s.fp_seconds || 0) >= 1
              ? `<span class="gs-analytics-tool-pill">First-Person <b>${escapeHtml(formatDurationCompact(s.fp_seconds))}</b></span>`
              : "",
            Number(s.measurements_count || 0) > 0
              ? `<span class="gs-analytics-tool-pill">Measurements <b>${Number(s.measurements_count)}</b></span>`
              : "",
            Number(s.comments_posted || 0) > 0
              ? `<span class="gs-analytics-tool-pill" style="border-color:#10b981;color:#10b981;">Comments Posted <b>${Number(s.comments_posted)}</b></span>`
              : "",
            Number(s.downloads_count || 0) > 0
              ? `<span class="gs-analytics-tool-pill">Downloads <b>${Number(s.downloads_count)}</b></span>`
              : "",
          ]
            .filter(Boolean)
            .join("");

          const evList = Array.isArray(s.events) ? s.events : [];
          const timelineHtml = evList.length
            ? `
              <details class="gs-analytics-timeline">
                <summary>Session Activity Timeline (${evList.length} event${evList.length === 1 ? "" : "s"})</summary>
                <div class="gs-analytics-timeline-list">
                  ${evList
                    .map(
                      (ev) =>
                        `<div><code>+${escapeHtml(formatDurationCompact(ev.t || 0))}</code> · <b>${escapeHtml(ev.type || "event")}:</b> ${escapeHtml(ev.detail || "")}</div>`
                    )
                    .join("")}
                </div>
              </details>
            `
            : "";

          return `
            <div class="gs-analytics-session-card">
              <div class="gs-analytics-session-top">
                <div class="gs-analytics-who">
                  ${liveBadge}
                  <span>${escapeHtml(displayWho)}</span>
                  ${emailBadge}
                </div>
                <div style="font-size:11px;color:var(--ui-text-secondary);display:flex;gap:10px;flex-wrap:wrap;">
                  <span>Active: <b style="color:var(--ui-accent);">${escapeHtml(formatDurationCompact(s.active_duration_sec || 0))}</b></span>
                  <span>Tab Open: <b style="color:var(--ui-text-primary);">${escapeHtml(formatDurationCompact(s.total_duration_sec || 0))}</b></span>
                  <span>3D Load: <b style="color:var(--ui-text-primary);">${escapeHtml(loadSummary)}</b></span>
                  <span style="color:var(--ui-text-muted);">${escapeHtml(s.started_at || "")}</span>
                </div>
              </div>
              <div class="gs-analytics-meta-row">
                <span><b>Location:</b> ${escapeHtml(locStr + ispStr)}</span>
                <span><b>IP:</b> <code>${escapeHtml(ipStr)}</code></span>
                <span><b>Device:</b> ${escapeHtml(deviceSummary)}</span>
                ${screenSummary ? `<span><b>Display:</b> ${escapeHtml(screenSummary)}</span>` : ""}
                ${localeSummary ? `<span><b>Locale:</b> ${escapeHtml(localeSummary)}</span>` : ""}
                ${s.connection_type ? `<span><b>Net:</b> ${escapeHtml(s.connection_type)}</span>` : ""}
                ${s.gpu_renderer ? `<span title="${escapeHtml(s.gpu_renderer)}"><b>GPU:</b> ${escapeHtml(String(s.gpu_renderer).slice(0, 56))}</span>` : ""}
                ${s.referrer ? `<span><b>Referrer:</b> ${escapeHtml(String(s.referrer).slice(0, 64))}</span>` : ""}
              </div>
              ${
                scanPillsHtml || toolPillsHtml || extraActionPills
                  ? `<div class="gs-analytics-tools-row">${scanPillsHtml}${toolPillsHtml}${extraActionPills}</div>`
                  : ""
              }
              ${timelineHtml}
            </div>
          `;
        })
        .join("");
    } catch (err) {
      listBox.innerHTML = `<div style="font-size:11.5px;color:#ef4444;padding:6px 2px;">Analytics error: ${escapeHtml(err.message || "Failed to load telemetry.")}</div>`;
    }
  }

  document.getElementById("btnRefreshShareAnalytics")?.addEventListener("click", () => {
    if (_activeAnalyticsToken) {
      openShareAnalyticsDrawer(_activeAnalyticsToken);
    }
  });
  document.getElementById("btnCloseShareAnalytics")?.addEventListener("click", () => {
    closeShareAnalyticsDrawer();
  });

  async function openSharingModal(defaultScope = "scan", defaultTarget = "", autoAnalyticsToken = "") {
    openModal("modalSharing");
    const roleInfo = getCurrentUserRoleInfo();
    const createBtn = document.getElementById("btnCreateShareLink");
    if (createBtn) createBtn.style.display = roleInfo.level >= 3 ? "" : "none";
    const scopeSel = document.getElementById("shareScopeType");
    const targetSel = document.getElementById("shareTargetId");
    const resolvedDefaultTarget =
      defaultTarget ||
      (defaultScope === "scan"
        ? STATE.activeScanId
        : STATE.activeProjectGroup && STATE.activeProjectGroup !== "__all__"
        ? STATE.activeProjectGroup
        : "");

    const populateTargets = () => {
      const st = scopeSel.value;
      targetSel.innerHTML = "";
      if (st === "scan") {
        STATE.scans.forEach((s) => {
          const opt = document.createElement("option");
          opt.value = s.scan_id;
          opt.textContent = `${s.name} (${s.project_group})`;
          targetSel.appendChild(opt);
        });
        if (resolvedDefaultTarget && STATE.scans.some((s) => s.scan_id === resolvedDefaultTarget)) {
          targetSel.value = resolvedDefaultTarget;
        }
      } else {
        const groups = [...new Set(STATE.scans.map((s) => s.project_group))];
        groups.forEach((g) => {
          const opt = document.createElement("option");
          opt.value = g;
          opt.textContent = g;
          targetSel.appendChild(opt);
        });
        if (resolvedDefaultTarget && groups.includes(resolvedDefaultTarget)) {
          targetSel.value = resolvedDefaultTarget;
        }
      }
      syncBannerWithSelectedTarget();
    };

    scopeSel.value = defaultScope;
    scopeSel.onchange = populateTargets;
    targetSel.onchange = syncBannerWithSelectedTarget;
    populateTargets();
    await renderShareLinksTable();
    syncBannerWithSelectedTarget();
    if (autoAnalyticsToken) {
      await openShareAnalyticsDrawer(autoAnalyticsToken);
    } else if (_activeAnalyticsToken && !_cachedShareLinksList.some((l) => l.token === _activeAnalyticsToken)) {
      closeShareAnalyticsDrawer();
    }
  }

  async function renderShareLinksTable(preferredBannerUrl = "", preferredBannerLabel = "") {
    const tbody = document.getElementById("shareLinksTableBody");
    if (!tbody) return;
    const roleInfo = getCurrentUserRoleInfo();
    const canManageLinks = roleInfo.level >= 3;
    try {
      const res = await apiGet("/api/share/list");
      const links = res.links || [];
      _cachedShareLinksList = links;
      tbody.innerHTML = "";
      if (!links.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="color:var(--ui-text-muted);">No external share links created yet. Click "Create &amp; Copy Link" above to generate a shareable URL.</td></tr>`;
        if (!preferredBannerUrl) showLatestShareLinkBanner("");
        return;
      }
      links.forEach((l) => {
        const tr = document.createElement("tr");
        const perms = [
          l.allow_measurements ? "Measure" : null,
          l.allow_comments ? "Comment" : null,
          l.allow_download ? "Download" : null,
        ]
          .filter(Boolean)
          .join(", ");
        const safeToken = escapeHtml(l.token || "");
        const fullShareUrl = buildPublicShareUrl(l.token || "");
        const safeFullUrl = escapeHtml(fullShareUrl);
        const scopeKind = String(l.scope_type || "scan").toUpperCase();
        const friendlyTarget = resolveShareScopeTitle(l.scope_type, l.target_id);
        const fullScopeTooltip = `${scopeKind}: ${friendlyTarget}${friendlyTarget !== l.target_id ? ` (${l.target_id})` : ""}`;

        const humanViews = Number(l.human_views ?? l.view_count ?? 0);
        const uniqVisitors = Number(l.unique_visitors || 0);
        const avgSec = Number(l.avg_active_sec || 0);
        const botUnfurls = Number(l.bot_unfurls || 0);
        const subStats = [
          uniqVisitors > 0 ? `${uniqVisitors} visitor${uniqVisitors === 1 ? "" : "s"}` : null,
          avgSec > 0 ? `Avg ${formatDurationCompact(avgSec)}` : null,
          botUnfurls > 0 ? `${botUnfurls} preview${botUnfurls === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(" · ");

        tr.innerHTML = `
          <td><b style="color:var(--ui-text-primary);">${escapeHtml(l.label || "")}</b></td>
          <td>
            <span class="gs-crs-pill gs-share-scope-pill" title="${escapeHtml(fullScopeTooltip)}">
              ${escapeHtml(scopeKind)}: ${escapeHtml(friendlyTarget)}
            </span>
          </td>
          <td>
            <div class="gs-share-url-group">
              <input
                type="text"
                class="gs-share-url-input"
                readonly
                value="${safeFullUrl}"
                title="${safeFullUrl}"
                style="${l.revoked ? "text-decoration:line-through;color:var(--ui-text-muted);" : ""}"
                aria-label="Full Share Link"
              />
              <button type="button" class="btn-xs primary gs-share-copy-btn" data-copy="${safeFullUrl}" title="Copy Full Share Link">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                <span>Copy</span>
              </button>
              <a href="${safeFullUrl}" target="_blank" rel="noopener noreferrer" class="btn-xs gs-share-open-btn" title="Open Share Link in New Tab">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              </a>
            </div>
          </td>
          <td style="font-size:11px;color:var(--ui-text-secondary);white-space:nowrap;">${escapeHtml(perms || "View")}</td>
          <td style="white-space:nowrap;">
            <div style="font-size:11.5px;font-weight:700;color:var(--ui-text-primary);">${humanViews} view${humanViews === 1 ? "" : "s"}</div>
            <div style="font-size:10px;color:var(--ui-text-muted);">${escapeHtml(subStats || "No telemetry yet")}</div>
          </td>
          <td>${
            l.revoked
              ? '<span style="color:var(--ui-text-muted);font-weight:700;font-size:11px;">REVOKED</span>'
              : '<span class="gs-crs-pill">ACTIVE</span>'
          }</td>
          <td style="display:flex;gap:5px;justify-content:flex-end;align-items:center;">
            <button type="button" class="btn-xs" data-analytics="${safeToken}" title="Inspect Visitor Sessions, Active Time, Devices &amp; Tools Used">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.9">
                <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
              </svg>
              <span>Analytics</span>
            </button>
            ${
              !canManageLinks
                ? ""
                : !l.revoked
                ? `<button type="button" class="btn-xs" data-revoke="${safeToken}" title="Revoke Access Immediately">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                      <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
                    </svg>
                  </button>`
                : `<button type="button" class="btn-xs" data-restore="${safeToken}" title="Restore Access">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                      <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                    </svg>
                  </button>`
            }
          </td>
        `;
        const urlInp = tr.querySelector(".gs-share-url-input");
        urlInp?.addEventListener("click", () => {
          urlInp.select();
        });
        const copyBtn = tr.querySelector("[data-copy]");
        copyBtn?.addEventListener("click", async () => {
          await copyTextToClipboard(fullShareUrl);
          urlInp?.select?.();
          flashCopyButtonState(copyBtn);
          showLatestShareLinkBanner(fullShareUrl, "Copied to Clipboard:");
          showToast(`Copied share link: ${fullShareUrl}`);
        });
        tr.querySelector("[data-analytics]")?.addEventListener("click", () => {
          openShareAnalyticsDrawer(l.token);
        });
        tr.querySelector("[data-revoke]")?.addEventListener("click", async () => {
          await apiPost("/api/share/revoke", { token: l.token });
          showToast(`Revoked external share link: ${fullShareUrl}`);
          await renderShareLinksTable();
          syncBannerWithSelectedTarget();
        });
        tr.querySelector("[data-restore]")?.addEventListener("click", async () => {
          await apiPost("/api/share/restore", { token: l.token });
          showToast(`Restored external share link: ${fullShareUrl}`);
          await renderShareLinksTable(fullShareUrl, "Restored Shareable Link:");
        });
        tbody.appendChild(tr);
      });
      if (preferredBannerUrl) {
        showLatestShareLinkBanner(preferredBannerUrl, preferredBannerLabel || "Shareable Link Ready:");
      }
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" style="color:var(--ui-text-secondary);">${escapeHtml(err.message || "")}</td></tr>`;
    }
  }

  document.getElementById("btnOpenSharing")?.addEventListener("click", () => openSharingModal());
  document.getElementById("btnCreateShareLink")?.addEventListener("click", async () => {
    const scope_type = document.getElementById("shareScopeType")?.value || "scan";
    const target_id = document.getElementById("shareTargetId")?.value || STATE.activeScanId;
    const label = document.getElementById("shareLabelInput")?.value || "External View Link";
    const allow_measurements = document.getElementById("shareAllowMeasure")?.checked ?? true;
    const allow_comments = document.getElementById("shareAllowComments")?.checked ?? true;
    const allow_download = document.getElementById("shareAllowDownload")?.checked ?? false;
    try {
      const res = await apiPost("/api/share/create", {
        scope_type,
        target_id,
        label,
        allow_measurements,
        allow_comments,
        allow_download,
      });
      const fullShareUrl = buildPublicShareUrl(res.link.token);
      const copiedOk = await copyTextToClipboard(fullShareUrl);
      await renderShareLinksTable(
        fullShareUrl,
        copiedOk ? "Created & Copied to Clipboard:" : "New Shareable Link Ready:"
      );
      const latestInp = document.getElementById("shareLatestUrlInput");
      latestInp?.select?.();
      if (copiedOk) {
        flashCopyButtonState(document.getElementById("btnCopyLatestShareUrl"));
        showToast(`Created & copied share link: ${fullShareUrl}`);
      } else {
        showToast(`Created share link: ${fullShareUrl}`);
      }
    } catch (err) {
      showToast(`Share Error: ${err.message}`);
    }
  });

  // 5B-2. Studio Menu Quick Single-Scan "View & Comment Only" Share Link Popover
  let _quickShareOutsideHandler = null;

  function closeQuickSingleScanSharePopover() {
    const existing = document.getElementById("gsStudioQuickSharePopover");
    if (existing) existing.remove();
    if (_quickShareOutsideHandler) {
      document.removeEventListener("mousedown", _quickShareOutsideHandler, true);
      _quickShareOutsideHandler = null;
    }
  }

  function isQuickViewCommentOnlyLink(linkObj, scanId) {
    if (!linkObj || linkObj.revoked) return false;
    return (
      String(linkObj.scope_type || "").toLowerCase() === "scan" &&
      String(linkObj.target_id || "") === String(scanId || "") &&
      Boolean(linkObj.allow_comments) === true &&
      Boolean(linkObj.allow_measurements) === false &&
      Boolean(linkObj.allow_download) === false
    );
  }

  async function ensureQuickViewCommentShareLink(scan, forceNew = false) {
    if (!scan || !scan.scan_id) throw new Error("No active scan selected.");
    if (!forceNew) {
      try {
        const listRes = await apiGet("/api/share/list");
        const allLinks = listRes.links || [];
        _cachedShareLinksList = allLinks;
        const existingMatch = allLinks.find((l) => isQuickViewCommentOnlyLink(l, scan.scan_id));
        if (existingMatch && existingMatch.token) {
          return existingMatch;
        }
      } catch (_) {}
    }
    const created = await apiPost("/api/share/create", {
      scope_type: "scan",
      target_id: scan.scan_id,
      label: `View & Comment — ${scan.name || scan.scan_id}`,
      allow_measurements: false,
      allow_comments: true,
      allow_download: false,
    });
    return created.link;
  }

  async function openQuickSingleScanSharePopover(anchorEl, scan) {
    if (!scan || !scan.scan_id) {
      showToast("Select a 3D scan first to generate a quick share link.");
      return;
    }
    const existing = document.getElementById("gsStudioQuickSharePopover");
    if (existing && existing.dataset.scanId === scan.scan_id && existing.dataset.anchorId === (anchorEl?.id || "")) {
      closeQuickSingleScanSharePopover();
      return;
    }
    closeQuickSingleScanSharePopover();
    if (typeof closeDownloadFormatMenu === "function") {
      closeDownloadFormatMenu();
    }

    const roleInfo = getCurrentUserRoleInfo();
    const canRevoke = roleInfo.level >= 3;
    const safeScanName = escapeHtml(scan.name || scan.scan_id);

    const pop = document.createElement("div");
    pop.id = "gsStudioQuickSharePopover";
    pop.className = "gs-quick-share-popover";
    pop.dataset.scanId = scan.scan_id;
    pop.dataset.anchorId = anchorEl?.id || "";
    pop.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding-bottom:7px;border-bottom:1px solid var(--ui-border);margin-bottom:8px;">
        <div style="min-width:0;">
          <div style="font-size:12px;font-weight:700;color:var(--ui-text-primary);display:flex;align-items:center;gap:6px;">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="var(--ui-accent)" stroke-width="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
            <span>Quick Share — Single-Scan View &amp; Comment</span>
          </div>
          <div style="font-size:10.5px;color:var(--ui-text-muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${safeScanName}">
            ${safeScanName}
          </div>
        </div>
        <button type="button" class="btn-xs" id="btnCloseQuickSharePop" title="Close" aria-label="Close Quick Share" style="height:22px;padding:0 5px;">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px;">
        <span class="gs-quick-share-chip" style="color:var(--ui-accent);border-color:var(--ui-accent);">3D View + Comment Only</span>
        <span class="gs-quick-share-chip">Single Scan Locked</span>
        <span class="gs-quick-share-chip">No Measurements</span>
        <span class="gs-quick-share-chip">No Download</span>
      </div>
      <div id="quickShareBodyArea" style="font-size:11.5px;color:var(--ui-text-secondary);padding:6px 0;">
        Preparing shareable link...
      </div>
    `;

    document.body.appendChild(pop);

    const positionPopover = () => {
      if (!anchorEl || typeof anchorEl.getBoundingClientRect !== "function") {
        pop.style.top = "64px";
        pop.style.right = "24px";
        return;
      }
      const rect = anchorEl.getBoundingClientRect();
      const popRect = pop.getBoundingClientRect();
      let left = rect.left;
      if (left + popRect.width > window.innerWidth - 12) {
        left = Math.max(12, window.innerWidth - popRect.width - 12);
      }
      let top = rect.bottom + 6;
      if (top + popRect.height > window.innerHeight - 12) {
        top = Math.max(12, rect.top - popRect.height - 6);
      }
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(top)}px`;
    };
    positionPopover();

    pop.querySelector("#btnCloseQuickSharePop")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeQuickSingleScanSharePopover();
    });

    _quickShareOutsideHandler = (ev) => {
      if (!pop.contains(ev.target) && (!anchorEl || !anchorEl.contains(ev.target))) {
        closeQuickSingleScanSharePopover();
      }
    };
    setTimeout(() => {
      if (_quickShareOutsideHandler && document.body.contains(pop)) {
        document.addEventListener("mousedown", _quickShareOutsideHandler, true);
      }
    }, 0);

    const renderReadyLink = async (linkObj, autoCopy = true) => {
      if (!document.body.contains(pop)) return;
      const fullUrl = buildPublicShareUrl(linkObj.token);
      const safeFullUrl = escapeHtml(fullUrl);
      const bodyArea = pop.querySelector("#quickShareBodyArea");
      if (!bodyArea) return;
      const humanViews = Number(linkObj.human_views ?? linkObj.view_count ?? 0);
      const uniqVisitors = Number(linkObj.unique_visitors || 0);
      const avgSec = Number(linkObj.avg_active_sec || 0);
      bodyArea.innerHTML = `
        <div class="gs-share-url-group" style="margin-bottom:8px;">
          <input type="text" class="gs-share-url-input" id="inpStudioQuickShareUrl" readonly value="${safeFullUrl}" title="${safeFullUrl}" aria-label="Single-Scan View and Comment Link" />
          <button type="button" class="btn-xs primary gs-share-copy-btn" id="btnCopyStudioQuickShareUrl" title="Copy Share Link">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            <span>Copy</span>
          </button>
          <a href="${safeFullUrl}" target="_blank" rel="noopener noreferrer" class="btn-xs gs-share-open-btn" title="Open Link in New Tab">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </a>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;padding-top:6px;border-top:1px solid var(--ui-border);">
          <span style="font-size:10.5px;color:var(--ui-text-muted);">
            Views: <b style="color:var(--ui-text-primary);">${humanViews}</b>
            · Visitors: <b style="color:var(--ui-text-primary);">${uniqVisitors}</b>
            ${avgSec > 0 ? `· Avg: <b style="color:var(--ui-accent);">${escapeHtml(formatDurationCompact(avgSec))}</b>` : ""}
          </span>
          <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;">
            <button type="button" class="btn-xs" id="btnQuickShareAnalytics" title="View who opened this link, for how long &amp; which 3D tools they used" style="font-size:10.5px;">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
              </svg>
              <span>Analytics</span>
            </button>
            ${
              canRevoke
                ? `<button type="button" class="btn-xs" id="btnRotateQuickShareUrl" title="Revoke current link and generate a new token" style="font-size:10.5px;">Reset Link</button>
                   <button type="button" class="btn-xs" id="btnRevokeQuickShareUrl" title="Revoke access immediately" style="font-size:10.5px;color:#ef4444;border-color:rgba(239,68,68,0.35);">Revoke</button>
                   <button type="button" class="btn-xs" id="btnOpenFullShareModalFromQuick" title="Custom permissions (Measurements, Download, Project Group)" style="font-size:10.5px;">More Options...</button>`
                : ""
            }
          </div>
        </div>
      `;
      positionPopover();

      const inpEl = bodyArea.querySelector("#inpStudioQuickShareUrl");
      const copyBtn = bodyArea.querySelector("#btnCopyStudioQuickShareUrl");
      inpEl?.addEventListener("click", () => inpEl.select());

      copyBtn?.addEventListener("click", async () => {
        await copyTextToClipboard(fullUrl);
        inpEl?.select?.();
        flashCopyButtonState(copyBtn);
        showToast(`Copied View & Comment link: ${fullUrl}`);
      });

      bodyArea.querySelector("#btnQuickShareAnalytics")?.addEventListener("click", () => {
        closeQuickSingleScanSharePopover();
        openSharingModal("scan", scan.scan_id, linkObj.token);
      });

      bodyArea.querySelector("#btnRotateQuickShareUrl")?.addEventListener("click", async () => {
        try {
          await apiPost("/api/share/revoke", { token: linkObj.token });
          const nextLink = await ensureQuickViewCommentShareLink(scan, true);
          await renderReadyLink(nextLink, true);
        } catch (err) {
          showToast(`Reset Link Error: ${err.message}`);
        }
      });

      bodyArea.querySelector("#btnRevokeQuickShareUrl")?.addEventListener("click", async () => {
        try {
          await apiPost("/api/share/revoke", { token: linkObj.token });
          showToast(`Revoked View & Comment link for ${scan.name || scan.scan_id}`);
          closeQuickSingleScanSharePopover();
        } catch (err) {
          showToast(`Revoke Error: ${err.message}`);
        }
      });

      bodyArea.querySelector("#btnOpenFullShareModalFromQuick")?.addEventListener("click", () => {
        closeQuickSingleScanSharePopover();
        openSharingModal("scan", scan.scan_id);
      });

      if (autoCopy) {
        const copiedOk = await copyTextToClipboard(fullUrl);
        inpEl?.select?.();
        if (copiedOk) {
          flashCopyButtonState(copyBtn);
          showToast(`Copied View & Comment link: ${fullUrl}`);
        }
      }
    };

    try {
      const linkObj = await ensureQuickViewCommentShareLink(scan, false);
      await renderReadyLink(linkObj, true);
    } catch (err) {
      const bodyArea = pop.querySelector("#quickShareBodyArea");
      if (bodyArea) {
        bodyArea.innerHTML = `<span style="color:#ef4444;font-size:11.5px;">${escapeHtml(err.message || "Failed to generate share link.")}</span>`;
      }
    }
  }

  document.getElementById("btnStudioQuickShare")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (STATE.multiAlign?.active) {
      showToast("Unavailable during Multi-Scan Editing — merge scans first to share unified scan");
      return;
    }
    const activeScan =
      STATE.activeScan || STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || null;
    openQuickSingleScanSharePopover(ev.currentTarget, activeScan);
  });

  document.getElementById("btnPreviewQuickShare")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const previewScan =
      STATE.scans.find((s) => s.scan_id === (STATE.selectedTimelineScanId || STATE.activeScanId)) ||
      STATE.activeScan ||
      null;
    openQuickSingleScanSharePopover(ev.currentTarget, previewScan);
  });

  // 5C. Client-Side Offline Cache & User Settings Modal (Requirement 5)
  async function openOfflineCacheModal() {
    openModal("modalOfflineCache");
    _pix4dSettingsDirty = false;
    await applyTheme(STATE.themePreference, false);
    applyRolePermissionsToUI();
    await renderAdminControlPanel();
    await refreshSettingsServiceAccountUI();
    apiGet("/api/pix4d/settings")
      .then((res) => {
        if (res && res.settings) applyPix4dSettingsToUI(res.settings, true);
      })
      .catch(() => {});
    const tbody = document.getElementById("offlineCacheTableBody");
    if (!tbody) return;
    tbody.innerHTML = "";
    STATE.scans.forEach((s) => {
      const isCached = STATE.cachedScanIds.has(s.scan_id);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><b style="color:var(--ui-text-primary);">${escapeHtml(s.name || s.scan_id || "")}</b></td>
        <td style="color:var(--ui-text-secondary);">${escapeHtml(s.project_group || "")}</td>
        <td><span class="gs-crs-pill">${escapeHtml(getScanCrsDisplayLabel(s))}</span></td>
        <td>${
          isCached
            ? '<span class="gs-crs-pill">Cached</span>'
            : '<span style="color:var(--ui-text-muted);">Uncached</span>'
        }</td>
        <td>
          <button type="button" class="btn-xs primary" data-cache-scan="${escapeHtml(s.scan_id || "")}" title="${isCached ? "Refresh Browser Cache" : "Cache in Browser"}">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
        </td>
      `;
      tr.querySelector("[data-cache-scan]")?.addEventListener("click", () => cacheScanInBrowser(s.scan_id));
      tbody.appendChild(tr);
    });
  }

  // Workstation PC Daemon Control in Admin Panel
  async function refreshAdminPcDaemonUI(preloadedStatus = null) {
    const badge = document.getElementById("badgeAdminPcDaemonStatus");
    const detail = document.getElementById("lblAdminPcDaemonDetail");
    const btnToggle = document.getElementById("btnAdminTogglePcDaemon");
    const btnSync = document.getElementById("btnAdminSyncPcInboxNow");
    if (!badge || !btnToggle) return;

    const myInfo = getCurrentUserRoleInfo();
    const canControl = Boolean(myInfo.can_manage_users || myInfo.can_run_workflows || myInfo.canManageUsers || myInfo.canRunWorkflows);
    btnToggle.disabled = !canControl;
    if (btnSync) btnSync.disabled = !canControl;

    let st = preloadedStatus;
    if (!st) {
      try {
        st = await apiGet("/api/admin/pc-daemon");
      } catch (_) {
        st = { pc_reachable: false, daemon_running: false, pc_online: false };
      }
    }

    const reachable = Boolean(st && st.pc_reachable);
    const running = Boolean(st && st.daemon_running);
    STATE.pcOnline = Boolean(st && st.pc_online);
    updatePcStatusUI();

    if (!reachable) {
      badge.textContent = "PC Unreachable (Tunnel Offline)";
      badge.style.background = "rgba(239,68,68,0.16)";
      badge.style.color = "#ef4444";
      btnToggle.textContent = "Start Daemon";
      if (detail) {
        detail.textContent = "Windows Workstation reverse tunnel is not connected. Serving scans from Google Drive .3tz Cloud & Browser Cache.";
      }
      return;
    }

    if (running) {
      badge.textContent = `Running (PID ${st.pid || "Active"})`;
      badge.style.background = "rgba(16,185,129,0.16)";
      badge.style.color = "#10b981";
      btnToggle.textContent = "Stop Daemon";
      btnToggle.style.background = "rgba(239,68,68,0.14)";
      btnToggle.style.color = "#ef4444";
      btnToggle.style.borderColor = "rgba(239,68,68,0.35)";
      const pollNote = st.last_poll_at
        ? `Last inbox poll: ${new Date(st.last_poll_at * 1000).toLocaleTimeString()}`
        : "Polling active";
      const jobNote = st.active_job
        ? ` · Active: ${st.active_job.name || st.active_job.scan_id} (${Math.round(st.active_job.progress_pct || 0)}%)`
        : ` · Queue: ${st.queued_count || 0} waiting · Total scans: ${st.total_scans || STATE.scans.length}`;
      if (detail) {
        detail.textContent = `${pollNote}${jobNote}`;
      }
    } else {
      badge.textContent = "Stopped (Standby)";
      badge.style.background = "rgba(245,158,11,0.16)";
      badge.style.color = "#f59e0b";
      btnToggle.textContent = "Start Daemon";
      btnToggle.style.background = "";
      btnToggle.style.color = "";
      btnToggle.style.borderColor = "";
      if (detail) {
        detail.textContent = "Background Google Drive Inbox polling & PIX4Dmatic queue are paused on PC. Click 'Start Daemon' to resume.";
      }
    }
  }

  document.getElementById("btnAdminTogglePcDaemon")?.addEventListener("click", async () => {
    const btnToggle = document.getElementById("btnAdminTogglePcDaemon");
    const wantStart = btnToggle?.textContent?.toLowerCase().includes("start");
    if (btnToggle) btnToggle.disabled = true;
    try {
      const res = await apiPost("/api/admin/pc-daemon", {
        actor_email: STATE.currentUser?.email || "",
        action: wantStart ? "start" : "stop",
      });
      await refreshAdminPcDaemonUI(res);
      showToast(res.message || (res.daemon_running ? "Workstation Daemon Started" : "Workstation Daemon Stopped"));
      if (res.daemon_running) {
        await refreshScansCatalog(false);
      }
    } catch (err) {
      showToast(`Daemon Control Error: ${err.message}`);
      await refreshAdminPcDaemonUI();
    } finally {
      if (btnToggle) btnToggle.disabled = false;
    }
  });

  document.getElementById("btnAdminSyncPcInboxNow")?.addEventListener("click", async () => {
    const btnSync = document.getElementById("btnAdminSyncPcInboxNow");
    if (btnSync) {
      btnSync.disabled = true;
      btnSync.textContent = "Syncing...";
    }
    try {
      const res = await apiPost("/api/admin/pc-daemon", {
        actor_email: STATE.currentUser?.email || "",
        action: "sync_now",
      });
      await refreshAdminPcDaemonUI(res);
      await refreshScansCatalog(false);
      showToast(res.message || "Synced Google Drive Inbox & .3tz packages!");
    } catch (err) {
      showToast(`Inbox Sync Error: ${err.message}`);
    } finally {
      if (btnSync) {
        btnSync.disabled = false;
        btnSync.textContent = "Sync Inbox Now";
      }
    }
  });

  document.getElementById("btnJumpQueueToSettings")?.addEventListener("click", () => {
    closeModal("modalQueue");
    openOfflineCacheModal();
  });

  // Admin Control Panel (5-Level Permissions & User Management)
  async function renderAdminControlPanel() {
    refreshAdminPcDaemonUI();
    const tbody = document.getElementById("adminUsersTableBody");
    const rolePill =
      document.getElementById("badgeCurrentUserRoleLevel") ||
      document.getElementById("adminCurrentUserRolePill");
    const saveBtn = document.getElementById("btnAdminSaveUser");
    const nameIn = document.getElementById("adminInputUserName") || document.getElementById("adminNewUserName");
    const zhNameIn = document.getElementById("adminInputUserZhName");
    const emailIn = document.getElementById("adminInputUserEmail") || document.getElementById("adminNewUserEmail");
    const roleSel = document.getElementById("adminSelectUserRole") || document.getElementById("adminNewUserRole");

    const myInfo = getCurrentUserRoleInfo();
    if (rolePill) {
      rolePill.textContent = `Active Role: L${myInfo.level} — ${myInfo.label}`;
    }
    const canManageUsers = Boolean(myInfo.canManageUsers || myInfo.can_manage_users);
    if (saveBtn) saveBtn.disabled = !canManageUsers;
    if (nameIn) nameIn.disabled = !canManageUsers;
    if (zhNameIn) zhNameIn.disabled = !canManageUsers;
    if (emailIn) emailIn.disabled = !canManageUsers;
    if (roleSel) roleSel.disabled = !canManageUsers;

    if (!tbody) return;
    let users = [];
    try {
      const res = await apiGet("/api/admin/users");
      if (res && Array.isArray(res.users)) {
        users = res.users;
        STATE.teamProfiles = users;
      }
    } catch (_) {
      users = STATE.teamProfiles || [];
    }

    tbody.innerHTML = "";
    users.forEach((u) => {
      const email = String(u.email || "").toLowerCase();
      const isOwner = OWNER_EMAILS_SET.has(email) || u.role === "owner";
      const uRole = isOwner ? "owner" : String(u.role || "viewer").toLowerCase();
      const uLevel = ROLE_LEVELS_MAP[uRole] || 2;
      const canEditRow =
        canManageUsers &&
        !isOwner &&
        (myInfo.role === "owner" || (myInfo.role === "admin" && uLevel < myInfo.level));

      const tr = document.createElement("tr");
      const roleOptionsHtml = ["owner", "admin", "editor", "viewer", "guest"]
        .map((rk) => {
          const disabledOpt =
            rk === "owner" || (myInfo.role === "admin" && (rk === "admin" || rk === "owner"));
          return `<option value="${rk}" ${uRole === rk ? "selected" : ""} ${
            disabledOpt && uRole !== rk ? "disabled" : ""
          }>L${ROLE_LEVELS_MAP[rk]} — ${ROLE_LABELS_MAP[rk]}</option>`;
        })
        .join("");

      const displayName = u.zh_name && u.zh_name !== u.name ? `${u.name} (${u.zh_name})` : (u.name || "User");
      tr.innerHTML = `
        <td><b style="color:var(--ui-text-primary);">${escapeHtml(displayName)}</b></td>
        <td style="font-family:var(--font-mono);font-size:11.5px;color:var(--ui-accent);">${escapeHtml(
          u.email || ""
        )}</td>
        <td>
          ${
            canEditRow
              ? `<select class="select-sm" data-admin-role-select="${escapeHtml(
                  u.email
                )}" style="height:26px;font-size:11.5px;padding:0 8px;">${roleOptionsHtml}</select>`
              : `<span class="gs-crs-pill" style="${
                  isOwner ? "background:rgba(37,99,235,0.16);color:#3b82f6;font-weight:800;" : ""
                }">L${uLevel} — ${escapeHtml(ROLE_LABELS_MAP[uRole] || u.role_label || uRole)}</span>`
          }
        </td>
        <td style="font-size:11px;color:var(--ui-text-secondary);">
          ${
            uRole === "owner"
              ? "All permissions + System Owner"
              : uRole === "admin"
              ? "Manage Editor/Viewer/Guest users + Editor tools"
              : uRole === "editor"
              ? "Rename sites/scans, run PIX4Dmatic & Optimizer"
              : uRole === "viewer"
              ? "View all scans + Measurement/Surveying tools (No PC jobs)"
              : "Browse & inspect scans + Distance/Area/Coordinates"
          }
        </td>
        <td>
          ${
            canEditRow
              ? `<button type="button" class="btn-xs" data-admin-delete-user="${escapeHtml(
                  u.email
                )}" style="color:#ef4444;border-color:rgba(239,68,68,0.35);" title="Remove user">Remove</button>`
              : `<span style="font-size:10.5px;color:var(--ui-text-muted);">${
                  isOwner ? "Protected Owner" : "Read-only"
                }</span>`
          }
        </td>
      `;

      const sel = tr.querySelector("[data-admin-role-select]");
      if (sel) {
        sel.addEventListener("change", async (e) => {
          const newRole = e.target.value;
          try {
            await apiPost("/api/admin/users/save", {
              actor_email: STATE.currentUser?.email || "",
              email: u.email,
              name: u.name,
              zh_name: u.zh_name || "",
              role: newRole,
            });
            showToast(`Updated ${u.name || u.email} to ${ROLE_LABELS_MAP[newRole] || newRole}`);
            await loadTeamUserProfiles();
            await renderAdminControlPanel();
            renderTeamProfilesGrid();
          } catch (err) {
            showToast(`Role Update Error: ${err.message}`);
            await renderAdminControlPanel();
          }
        });
      }

      const delBtn = tr.querySelector("[data-admin-delete-user]");
      if (delBtn) {
        delBtn.addEventListener("click", async () => {
          try {
            await apiPost("/api/admin/users/delete", {
              actor_email: STATE.currentUser?.email || "",
              email: u.email,
            });
            showToast(`Removed user ${u.email}`);
            await loadTeamUserProfiles();
            await renderAdminControlPanel();
            renderTeamProfilesGrid();
          } catch (err) {
            showToast(`Delete User Error: ${err.message}`);
          }
        });
      }

      tbody.appendChild(tr);
    });
  }

  document.getElementById("btnAdminSaveUser")?.addEventListener("click", async () => {
    const nameEl = document.getElementById("adminInputUserName") || document.getElementById("adminNewUserName");
    const zhNameEl = document.getElementById("adminInputUserZhName");
    const emailEl = document.getElementById("adminInputUserEmail") || document.getElementById("adminNewUserEmail");
    const roleEl = document.getElementById("adminSelectUserRole") || document.getElementById("adminNewUserRole");
    const name = nameEl?.value?.trim() || "";
    const zh_name = zhNameEl?.value?.trim() || "";
    const email = emailEl?.value?.trim() || "";
    const role = roleEl?.value || "viewer";
    const statusEl = document.getElementById("adminActionStatusMsg");
    if (!email || !email.includes("@")) {
      showToast("Please enter a valid user email address.");
      return;
    }
    try {
      const res = await apiPost("/api/admin/users/save", {
        actor_email: STATE.currentUser?.email || "",
        email,
        name: name || zh_name || email.split("@")[0],
        zh_name,
        role,
      });
      if (nameEl) nameEl.value = "";
      if (zhNameEl) zhNameEl.value = "";
      if (emailEl) emailEl.value = "";
      if (statusEl) {
        statusEl.style.display = "block";
        statusEl.style.color = "#10b981";
        statusEl.textContent = `Saved ${res.user?.name || email} (${res.user?.role_label || role}).`;
      }
      showToast(`Saved user ${email} as ${ROLE_LABELS_MAP[role] || role}`);
      await loadTeamUserProfiles();
      await renderAdminControlPanel();
      renderTeamProfilesGrid();
    } catch (err) {
      if (statusEl) {
        statusEl.style.display = "block";
        statusEl.style.color = "#ef4444";
        statusEl.textContent = `Error: ${err.message}`;
      }
      showToast(`Admin Error: ${err.message}`);
    }
  });

  // Google Service Account Settings & Live Verification
  async function refreshSettingsServiceAccountUI() {
    const pill = document.getElementById("badgeSettingsSaStatus") || document.getElementById("settingsSaStatusPill");
    const box = document.getElementById("boxServiceAccountTestResult") || document.getElementById("settingsSaTestResultBox");
    try {
      const status = await apiGet("/api/cloud-manifest/status");
      const isReady = Boolean(status.auth_configured || status.private_key_loaded || status.has_credentials);
      if (pill) {
        if (isReady) {
          pill.textContent = "Connected & Verified";
          pill.style.background = "rgba(16,185,129,0.16)";
          pill.style.color = "#10b981";
        } else {
          pill.textContent = "Key Needed (.json)";
          pill.style.background = "rgba(245,158,11,0.16)";
          pill.style.color = "#f59e0b";
        }
      }
      if (box) {
        box.style.display = "block";
        if (isReady) {
          const saEmail = status.service_account_email || status.expected_service_account_email || "gcworker@modular-temple-508005-c4.iam.gserviceaccount.com";
          const projId = status.expected_project_id || "modular-temple-508005-c4";
          const keyId = status.private_key_id ? ` (Key ID: ${status.private_key_id.slice(0, 12)}…)` : "";
          const totalPkgs = Number(status.total_packages || 0);
          const syncedPkgs = Math.max(Number(status.synced_shared_drive_count || 0), Number(status.synced_my_drive_count || 0), totalPkgs);
          box.textContent =
            `✓ Active Service Account: ${saEmail}\n` +
            `✓ Project ID: ${projId}${keyId}\n` +
            `✓ OAuth2 Bearer Token: ${status.auth_configured ? "Active (RS256 JWT Verified)" : "Private Key Loaded"}\n` +
            `✓ Synced .3tz Cloud Packages: ${syncedPkgs} / ${totalPkgs} (${status.total_size_mb || 0} MB)`;
        } else {
          box.textContent = `Target Service Account: ${
            status.expected_service_account_email || "gcworker@modular-temple-508005-c4.iam.gserviceaccount.com"
          }\nStatus: Waiting for service account .json private key file.`;
        }
      }
    } catch (_) {}
  }

  async function testGDriveServiceAccountLive(customJsonStr = "") {
    const pill = document.getElementById("badgeSettingsSaStatus") || document.getElementById("settingsSaStatusPill");
    const box = document.getElementById("boxServiceAccountTestResult") || document.getElementById("settingsSaTestResultBox");
    if (pill) {
      pill.textContent = "Testing...";
      pill.style.background = "rgba(59,130,246,0.16)";
      pill.style.color = "#3b82f6";
    }
    if (box) {
      box.style.display = "block";
      box.textContent = "Testing OAuth2 JWT assertion & Google Drive API v3 folder access for gcworker@modular-temple-508005-c4.iam.gserviceaccount.com...";
    }
    try {
      const payload = customJsonStr ? { service_account_json: customJsonStr } : {};
      const res = await apiPost("/api/cloud-manifest/test-sa", payload);
      const isOk = Boolean(res && (res.ok || res.status === "ok"));
      if (isOk) {
        if (pill) {
          pill.textContent = "Connected & Verified";
          pill.style.background = "rgba(16,185,129,0.16)";
          pill.style.color = "#10b981";
        }
        const filesList = res.visible_files || res.sample_files || [];
        const filesSummary = filesList
          .slice(0, 8)
          .map((f) => `• ${f.name} (${f.id})`)
          .join("\n");
        if (box) {
          box.textContent =
            `✓ Service Account Authenticated: ${res.configured_service_account || res.client_email}\n` +
            `✓ Project ID: ${res.expected_project_id || res.project_id}\n` +
            `✓ OAuth2 Token & Drive v3 Access: OK (Range Read: ${res.range_read_ok ? "OK" : "Tested"})\n` +
            `✓ Drive Folder (${res.stream_packages_folder_id || res.folder_id}): ${res.files_visible_count} files visible\n` +
            (filesSummary ? `Visible files:\n${filesSummary}` : "");
        }
        showToast("Service Account verified & Google Drive synced!");
        await refreshScansCatalog(false);
      } else {
        if (pill) {
          pill.textContent = res?.private_key_loaded ? "Auth Error" : "Key Needed (.json)";
          pill.style.background = "rgba(239,68,68,0.16)";
          pill.style.color = "#ef4444";
        }
        if (box) {
          box.textContent = `✗ Service Account Test Result (${res?.status || "error"}):\n${
            res?.message || res?.error || "Failed to authenticate service account."
          }`;
        }
        showToast(res?.message || res?.error || "Service Account key required");
      }
    } catch (err) {
      if (box) {
        box.textContent = `✗ Service Account Test Error: ${err.message}`;
      }
      showToast(`Service Account Error: ${err.message}`);
    }
  }

  document.getElementById("btnTestServiceAccountLive")?.addEventListener("click", () => {
    const pasted = document.getElementById("txtServiceAccountJsonUser")?.value?.trim() || "";
    testGDriveServiceAccountLive(pasted);
  });

  document.getElementById("btnSaveServiceAccountJsonUser")?.addEventListener("click", async () => {
    const pasted = document.getElementById("txtServiceAccountJsonUser")?.value?.trim() || "";
    if (!pasted) {
      showToast("Paste the Service Account JSON key first or click Upload .JSON Key.");
      return;
    }
    await testGDriveServiceAccountLive(pasted);
  });

  document.getElementById("fileServiceAccountJsonUser")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const txtEl = document.getElementById("txtServiceAccountJsonUser");
      if (txtEl) txtEl.value = text;
      await testGDriveServiceAccountLive(text);
    } catch (err) {
      showToast(`Failed to read JSON file: ${err.message}`);
    }
  });

  async function cacheScanInBrowser(scanId) {
    try {
      const manifest = await apiGet(`/api/cache/manifest/${encodeURIComponent(scanId)}`);
      if ("caches" in window) {
        const cache = await caches.open("gathering-scans-tiles-v1");
        for (const u of manifest.asset_urls || []) {
          await cache.add(u).catch(() => {});
        }
      }
      STATE.cachedScanIds.add(scanId);
      localStorage.setItem("gs_cached_scans", JSON.stringify([...STATE.cachedScanIds]));
      const sName = manifest?.scan?.name || scanId;
      showToast(`Cached ${sName} in local browser CacheStorage (0B on Linux VPS)`);
      await openOfflineCacheModal();
      renderMapClusters();
    } catch (err) {
      showToast(`Offline Cache Error: ${err.message}`);
    }
  }

  document.getElementById("btnOpenOfflineCache")?.addEventListener("click", openOfflineCacheModal);
  document.getElementById("chkEnableOfflineCache")?.addEventListener("change", async (e) => {
    const enabled = Boolean(e.target.checked);
    if (STATE.currentUser) STATE.currentUser.offlineCacheEnabled = enabled;
    await apiPost("/api/user/settings", {
      user_email: STATE.currentUser?.email || "guest@gatheren.cloud",
      user_name: STATE.currentUser?.name || "Engineer",
      offline_cache_enabled: enabled,
      theme_preference: STATE.themePreference,
    }).catch(() => {});
    showToast(enabled ? "Enabled Browser Offline Caching" : "Disabled Browser Offline Caching");
  });
  document.getElementById("btnToggleSimulatedOffline")?.addEventListener("click", async () => {
    const newOffline = STATE.pcOnline;
    const res = await apiPost("/api/pc/simulate-offline", { offline: newOffline });
    STATE.pcOnline = res.pc_online;
    updatePcStatusUI();
    refreshAdminPcDaemonUI();
    showToast(
      STATE.pcOnline
        ? "PC Online — Workstation Daemon Active"
        : "PC Daemon Stopped — Viewing scans from Cloud / Local Browser CacheStorage"
    );
  });

  function updatePcStatusUI() {
    const chip = document.getElementById("pcStatusChip");
    const txt = document.getElementById("pcStatusText");
    const btnSim = document.getElementById("btnToggleSimulatedOffline");
    if (!chip || !txt) return;
    if (STATE.pcOnline) {
      chip.classList.remove("state-offline");
      txt.textContent = "Queue";
      if (btnSim) btnSim.textContent = "Offline";
    } else {
      chip.classList.add("state-offline");
      txt.textContent = "Offline";
      if (btnSim) btnSim.textContent = "Online";
    }
  }

  // ============================================================================
  // 5D. GATHERINGCLOUD GOOGLE OAUTH & USER PROFILE GATE
  //     (Same Client ID 753778992341-hpe65ilnti31j0m7etmq5rn7a1q802da... & Server Persistence)
  // ============================================================================
  function parseGoogleJwt(token) {
    try {
      const parts = String(token || "").split(".");
      if (parts.length < 2) return null;
      const base64Url = parts[1];
      const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
      const jsonPayload = decodeURIComponent(
        window
          .atob(base64)
          .split("")
          .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
          .join("")
      );
      return JSON.parse(jsonPayload);
    } catch (e) {
      return null;
    }
  }

  function applyUserProfileToUI(userObj, markAuthorized = false) {
    const closeBtn = document.getElementById("btnCloseAuthGateModal");
    const confirmBtn = document.getElementById("btnGateConfirmEnter");
    const btnLogout = document.getElementById("btnUserLogout");
    const gateStatus = document.getElementById("gateActiveUserStatusText");
    const lblUser = document.getElementById("lblCurrentUser");
    const avatarImg = document.getElementById("imgCurrentUserAvatar");
    const svgIcon = document.getElementById("svgCurrentUserIcon");

    if (!userObj) {
      STATE.currentUser = null;
      syncSessionTokenCookie(null);
      if (!STATE.shareToken) {
        STATE.isAuthorized = false;
        document.body?.classList.add("gs-auth-locked");
      }
      if (lblUser) lblUser.textContent = "Sign In";
      if (avatarImg) avatarImg.style.display = "none";
      if (svgIcon) svgIcon.style.display = "inline-block";
      if (closeBtn) closeBtn.style.display = "none";
      if (confirmBtn) confirmBtn.style.display = "none";
      if (btnLogout) btnLogout.style.display = "none";
      if (gateStatus) {
        gateStatus.textContent =
          "Authorization required — Sign in with Google or use Guest Mode";
      }
      applyRolePermissionsToUI();
      return;
    }

    if (markAuthorized) {
      STATE.isAuthorized = true;
      try {
        localStorage.setItem("gs_auth_verified_v1", "1");
      } catch (e) {}
    }
    if (STATE.isAuthorized || STATE.shareToken) {
      document.body?.classList.remove("gs-auth-locked");
    }

    const normalized = Object.assign({}, userObj);
    if (!normalized.avatar_url && normalized.picture) {
      normalized.avatar_url = normalized.picture;
    }
    if (!normalized.picture && normalized.avatar_url) {
      normalized.picture = normalized.avatar_url;
    }
    STATE.currentUser = Object.assign({ offlineCacheEnabled: true }, STATE.currentUser || {}, normalized);
    syncSessionTokenCookie(STATE.currentUser);
    const dlBtn = document.getElementById("btnStudioDownloadObj");
    if (dlBtn && STATE.activeScanId) {
      dlBtn.href = appendAuthToDownloadUrl(
        STATE.activeScan?.download_obj_url || `/api/download?scan_id=${encodeURIComponent(STATE.activeScanId)}&type=obj`
      );
    }
    try {
      localStorage.setItem("gathering_user_profile", JSON.stringify(STATE.currentUser));
      localStorage.setItem("gs_current_user", JSON.stringify(STATE.currentUser));
    } catch (e) {
      // ignore
    }

    const rInfo = getCurrentUserRoleInfo();
    if (lblUser) {
      lblUser.textContent = `${STATE.currentUser.name || STATE.currentUser.email || "Guest"} (${rInfo.label})`;
    }
    const btnUser = document.getElementById("btnGoogleUser") || document.getElementById("btnCurrentUserProfile");
    if (btnUser) {
      btnUser.title = `${STATE.currentUser.name || "User"} (${STATE.currentUser.email || ""}) — Role: ${rInfo.level}. ${rInfo.label}`;
    }
    if (avatarImg && svgIcon) {
      const picUrl = STATE.currentUser.avatar_url || STATE.currentUser.picture;
      if (picUrl) {
        avatarImg.src = picUrl;
        avatarImg.style.display = "inline-block";
        svgIcon.style.display = "none";
      } else {
        avatarImg.style.display = "none";
        svgIcon.style.display = "inline-block";
      }
    }

    const offlineLbl = document.getElementById("lblOfflineCacheUserEmail");
    if (offlineLbl) {
      offlineLbl.textContent = `Enable Offline Caching in Browser (${STATE.currentUser.email || "guest"})`;
    }
    const engInput = document.getElementById("cntEngineerName");
    if (engInput && STATE.currentUser.name) {
      engInput.value = STATE.currentUser.name;
    }
    if (gateStatus) {
      gateStatus.textContent = `Signed in as: ${STATE.currentUser.name || STATE.currentUser.email} (${STATE.currentUser.email || ""}) — ${rInfo.level}. ${rInfo.label}`;
    }
    if (closeBtn) {
      closeBtn.style.display = STATE.isAuthorized ? "inline-flex" : "none";
    }
    if (confirmBtn) {
      confirmBtn.style.display = STATE.isAuthorized ? "inline-flex" : "none";
    }
    if (btnLogout) {
      btnLogout.style.display = STATE.isAuthorized ? "inline-flex" : "none";
    }
    applyRolePermissionsToUI();
  }

  async function loadTeamUserProfiles() {
    try {
      const res = await apiGet("/api/user-profiles");
      if (Array.isArray(res.profiles)) {
        STATE.teamProfiles = res.profiles;
      } else if (res.profiles && typeof res.profiles === "object") {
        STATE.teamProfiles = Object.values(res.profiles);
      }
      STATE.teamProfiles = (STATE.teamProfiles || []).map((u) => {
        if (
          u &&
          String(u.email || "").toLowerCase() === "glibivanov@gatheren.com.tw" &&
          (!u.name || u.name === "Glib Ivanov")
        ) {
          return Object.assign({}, u, { name: "雲在天" });
        }
        return u;
      });
    } catch (e) {
      // Fallback to seeded team profiles if offline
      if (!STATE.teamProfiles.length) {
        STATE.teamProfiles = [
          {
            id: "u_glibivanov",
            name: "雲在天",
            email: "glibivanov@gatheren.com.tw",
            role: "owner",
            role_label: "Owner (System Owner)",
            auth_provider: "google",
          },
          {
            id: "u_glebivanov",
            name: "雲在天 (Glib Ivanov)",
            email: "gleb.ivanov1999@gmail.com",
            role: "owner",
            role_label: "Owner (System Owner)",
            auth_provider: "google",
          },
          {
            id: "u_frankchao",
            name: "趙冠人",
            email: "frankchao@gatheren.com.tw",
            role: "admin",
            role_label: "General Manager (Gatheren)",
            auth_provider: "google",
          },
        ];
      }
    }
  }

  function renderTeamProfilesGrid() {
    const grid = document.getElementById("gateExistingUsersGrid");
    const countBadge = document.getElementById("gateRosterCountBadge");
    const searchInput = document.getElementById("gateUserSearchInput");
    if (!grid) return;

    const q = String(searchInput?.value || "").trim().toLowerCase();
    const list = (STATE.teamProfiles || []).filter((u) => {
      if (!q) return true;
      return (
        (u.name || "").toLowerCase().includes(q) ||
        (u.email || "").toLowerCase().includes(q) ||
        (u.role_label || u.role || "").toLowerCase().includes(q)
      );
    });

    if (countBadge) {
      countBadge.textContent = `${list.length} Member${list.length === 1 ? "" : "s"}`;
    }

    grid.innerHTML = "";
    list.forEach((u) => {
      const isCurrent =
        STATE.isAuthorized &&
        STATE.currentUser &&
        String(STATE.currentUser.email || "").toLowerCase() === String(u.email || "").toLowerCase();
      const initials = (u.name || u.email || "U")
        .split(" ")
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
      const picUrl = u.avatar_url || u.picture || "";
      const card = document.createElement("button");
      card.type = "button";
      card.style.cssText = `
        display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:10px;
        border:1.5px solid ${isCurrent ? "var(--ui-accent)" : "var(--ui-border)"};
        background:${isCurrent ? "var(--ui-accent-soft)" : "var(--ui-bg-surface)"};
        cursor:pointer;text-align:left;width:100%;transition:all 0.14s ease;
      `;
      const safePicUrl = escapeHtml(picUrl);
      const safeInitials = escapeHtml(initials);
      const safeName = escapeHtml(u.name || u.email || "Team Member");
      const safeEmail = escapeHtml(u.email || "");
      const safeRoleLbl = escapeHtml(u.role_label || u.role || "Team Member");
      card.innerHTML = `
        ${
          safePicUrl
            ? `<img src="${safePicUrl}" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;" />`
            : `<div style="width:32px;height:32px;border-radius:50%;background:${isCurrent ? "var(--ui-accent)" : "#334155"};color:#ffffff;font-size:11.5px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${safeInitials}</div>`
        }
        <div style="overflow:hidden;flex:1;">
          <div style="font-size:12.5px;font-weight:700;color:var(--ui-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${safeName}</div>
          <div style="font-size:10.5px;color:var(--ui-accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${safeEmail}</div>
          <div style="font-size:10px;color:var(--ui-text-muted);">${safeRoleLbl}</div>
        </div>
      `;
      card.addEventListener("click", () => {
        if (isCurrent && STATE.currentUser?.session_token) {
          closeModal("userProfileGateModal");
          return;
        }
        promptChooseGoogleAccountOAuth();
        showToast(`Please sign in with Google (${u.email}) to verify this account`);
      });
      grid.appendChild(card);
    });
  }

  const REGISTERED_GOOGLE_OAUTH_ORIGINS = new Set([
    "https://scans.gatheren.cloud",
    "https://www.scans.gatheren.cloud",
    "https://gatheren.cloud",
    "https://www.gatheren.cloud",
    "https://www.dev.gatheren.cloud",
    "http://localhost:8099",
  ]);

  function initGoogleIdentityServicesButton(retryCount = 0) {
    const curOrigin = window.location.origin;
    const originEl = document.getElementById("currentOriginCode");
    if (originEl) {
      originEl.textContent = curOrigin;
    }

    const warnBox = document.getElementById("localOriginOAuthWarning");
    const warnLbl = document.getElementById("unregisteredOriginLabel");
    if (warnBox) {
      if (!REGISTERED_GOOGLE_OAUTH_ORIGINS.has(curOrigin)) {
        if (warnLbl) warnLbl.textContent = curOrigin;
        warnBox.style.display = "block";
      } else {
        warnBox.style.display = "none";
      }
    }

    const btnContainer = document.getElementById("googleSignInButtonContainer");
    if (window.google && window.google.accounts && window.google.accounts.id && btnContainer) {
      try {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_OAUTH_CLIENT_ID,
          callback: window.handleGoogleSignIn,
          auto_select: false,
          cancel_on_tap_outside: true,
          itp_support: true,
          use_fedcm_for_prompt: false,
        });
        if (!btnContainer.querySelector("iframe")) {
          btnContainer.innerHTML = "";
          window.google.accounts.id.renderButton(btnContainer, {
            type: "standard",
            theme: STATE.resolvedTheme === "dark" ? "filled_black" : "outline",
            size: "large",
            text: "continue_with",
            shape: "rectangular",
            logo_alignment: "left",
            width: 260,
          });
        }
      } catch (e) {
        console.warn("[GatheringScans] Google Identity Services render note:", e);
      }
    } else if (retryCount < 10) {
      setTimeout(() => initGoogleIdentityServicesButton(retryCount + 1), 350);
    }
  }

  async function completeGoogleProfileSignIn(profileData, rawCredential = "") {
    const msgEl = document.getElementById("googleAuthMessage");
    if (msgEl) {
      msgEl.style.color = "var(--ui-accent)";
      msgEl.textContent = "Verifying Google account & role permissions...";
    }
    try {
      const res = await apiPost("/api/auth/google", {
        credential: rawCredential,
        profile: profileData,
      });
      const verifiedUser = res.user || profileData;
      if (Array.isArray(res.profiles)) {
        STATE.teamProfiles = res.profiles;
      } else if (res.profiles && typeof res.profiles === "object") {
        STATE.teamProfiles = Object.values(res.profiles);
      }
      applyUserProfileToUI(verifiedUser, true);
      renderTeamProfilesGrid();
      if (msgEl) {
        msgEl.style.color = "var(--ui-accent)";
        msgEl.innerHTML = `Verified Google Account: <b>${escapeHtml(verifiedUser.name)}</b> (${escapeHtml(verifiedUser.email)})`;
      }
      showToast(`Signed in with Google OAuth as ${verifiedUser.name} (${verifiedUser.email})`);
      setTimeout(() => {
        closeModal("userProfileGateModal");
      }, 550);
    } catch (err) {
      const errMsg = err?.message || "Unable to verify Google Sign-In token";
      if (msgEl) {
        msgEl.style.color = "#ef4444";
        msgEl.textContent = `Google Sign-In verification failed: ${errMsg}`;
      }
      showToast(`Google Sign-In verification failed: ${errMsg}`);
    }
  }

  window.handleGoogleSignIn = async function (response) {
    if (!response || !response.credential) return;
    const jwtPayload = parseGoogleJwt(response.credential) || {};
    const fallbackProfile = {
      id: jwtPayload.sub ? `google_${jwtPayload.sub}` : undefined,
      name: jwtPayload.name || jwtPayload.given_name || (jwtPayload.email ? jwtPayload.email.split("@")[0] : "Google User"),
      email: jwtPayload.email || "",
      avatar_url: jwtPayload.picture || "",
      picture: jwtPayload.picture || "",
      google_sub: jwtPayload.sub || "",
      auth_provider: "google",
      isGoogleAuthenticated: true,
    };
    await completeGoogleProfileSignIn(fallbackProfile, response.credential);
  };

  function promptChooseGoogleAccountOAuth() {
    const curOrigin = window.location.origin;
    if (!REGISTERED_GOOGLE_OAUTH_ORIGINS.has(curOrigin)) {
      showToast("Local IP is not in Google OAuth Origins — opening https://scans.gatheren.cloud or pick a Team Account below");
      const warnBox = document.getElementById("localOriginOAuthWarning");
      if (warnBox) warnBox.style.display = "block";
      return;
    }
    if (window.google?.accounts?.id) {
      try {
        window.google.accounts.id.disableAutoSelect();
      } catch (_) {}
    }
    if (window.google?.accounts?.oauth2?.initTokenClient) {
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        scope: "openid email profile",
        prompt: "select_account",
        callback: async (tokenResponse) => {
          if (!tokenResponse || tokenResponse.error || !tokenResponse.access_token) {
            return;
          }
          try {
            const uResp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
              headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
            });
            if (!uResp.ok) throw new Error(`HTTP ${uResp.status}`);
            const info = await uResp.json();
            const chosenProfile = {
              id: info.sub ? `google_${info.sub}` : undefined,
              name: info.name || info.given_name || (info.email ? info.email.split("@")[0] : "Google User"),
              email: info.email || "",
              avatar_url: info.picture || "",
              picture: info.picture || "",
              google_sub: info.sub || "",
              auth_provider: "google",
              isGoogleAuthenticated: true,
            };
            await completeGoogleProfileSignIn(chosenProfile, "");
          } catch (err) {
            showToast(`Google Account Selection Error: ${err.message}`);
          }
        },
      });
      tokenClient.requestAccessToken({ prompt: "select_account" });
    } else {
      showToast("Google OAuth client is loading — please click again in a moment.");
      initGoogleIdentityServicesButton(0);
    }
  }

  async function openUserProfileGateModal() {
    openModal("userProfileGateModal");
    await loadTeamUserProfiles();
    applyUserProfileToUI(STATE.currentUser, false);
    renderTeamProfilesGrid();
    initGoogleIdentityServicesButton();
  }

  window.openUserProfileGateModal = openUserProfileGateModal;
  window.checkUserProfileGate = openUserProfileGateModal;

  document.getElementById("btnGoogleUser")?.addEventListener("click", () => {
    openUserProfileGateModal();
  });
  document.getElementById("btnCurrentUserProfile")?.addEventListener("click", () => {
    openUserProfileGateModal();
  });
  document.getElementById("btnChooseGoogleAccountOAuth")?.addEventListener("click", () => {
    promptChooseGoogleAccountOAuth();
  });
  document.getElementById("btnCloseAuthGateModal")?.addEventListener("click", () => {
    closeModal("userProfileGateModal");
  });
  document.getElementById("btnGateConfirmEnter")?.addEventListener("click", () => {
    if (!STATE.isAuthorized && !STATE.shareToken) {
      showToast("Please sign in with Google or choose Guest Mode");
      return;
    }
    closeModal("userProfileGateModal");
    if (STATE.currentUser) {
      showToast(`Active user: ${STATE.currentUser.name} (${STATE.currentUser.email})`);
    }
  });
  document.getElementById("btnGateGuestEnter")?.addEventListener("click", () => {
    applyUserProfileToUI(
      {
        id: "guest_viewer",
        name: "Guest Viewer",
        email: "guest@gatheren.cloud",
        role: "guest",
        role_label: "Read-Only Guest",
        avatar_url: "",
        auth_provider: "guest",
      },
      true
    );
    closeModal("userProfileGateModal");
    showToast("Entered in Guest Mode");
  });
  document.getElementById("btnUserLogout")?.addEventListener("click", () => {
    try {
      localStorage.removeItem("gs_auth_verified_v1");
      localStorage.removeItem("gathering_user_profile");
      localStorage.removeItem("gs_current_user");
    } catch (e) {}
    if (window.google?.accounts?.id) {
      try {
        window.google.accounts.id.disableAutoSelect();
      } catch (e) {}
    }
    applyUserProfileToUI(null, false);
    renderTeamProfilesGrid();
    openModal("userProfileGateModal");
    showToast("Signed out — Authorization required to continue");
  });
  document.getElementById("gateUserSearchInput")?.addEventListener("input", () => {
    renderTeamProfilesGrid();
  });
  document.getElementById("btnCopyCurrentOriginGate")?.addEventListener("click", () => {
    navigator.clipboard?.writeText(window.location.origin);
    showToast(`Copied Authorized JavaScript Origin: ${window.location.origin}`);
  });

  // ============================================================================
  // 6. SCALABLE PROJECT & SCAN SELECTOR WIRING + VIEW NAVIGATION
  // ============================================================================
  document.getElementById("mapProjectSearchInput")?.addEventListener("input", (e) => {
    STATE.projectFilterQuery = String(e.target.value || "").trim();
    renderMapClusters();
  });

  document.getElementById("mapProjectSelect")?.addEventListener("change", (e) => {
    const val = e.target.value;
    if (!val || val === "__all__") {
      STATE.activeProjectGroup = "__all__";
      document.getElementById("clusterHoverPopover")?.classList.remove("active");
      document.querySelectorAll(".scan-cluster-blob").forEach((b) => b.classList.remove("active-cluster"));
      openSiteTimeline("__all__");
      if (gsMap) {
        gsMap.selectedGroup = null;
        fitMapToAllGeorefGroups();
        gsMap.drawMap();
      }
      return;
    }
    const grp = getProjectGroupsList("").find((g) => g.project_group === val);
    if (grp && gsMap) {
      STATE.activeProjectGroup = grp.project_group;
      if (grp.hasGeoref && Number.isFinite(grp.lat) && Number.isFinite(grp.lon)) {
        gsMap.centerLat = grp.lat;
        gsMap.centerLon = grp.lon;
        gsMap.zoom = 14.5;
      }
      openClusterPopover(grp);
      openSiteTimeline(grp.project_group);
      gsMap.drawMap();
    }
  });

  document.getElementById("btnOpenSelectedProjectTimeline")?.addEventListener("click", () => {
    const selVal = document.getElementById("mapProjectSelect")?.value;
    const targetGroup = selVal || STATE.activeProjectGroup || "__all__";
    openSiteTimeline(targetGroup);
  });

  document.getElementById("timelineProjectSelect")?.addEventListener("change", (e) => {
    const val = e.target.value;
    if (val) {
      if (val === "__all__") {
        STATE.activeProjectGroup = "__all__";
        document.getElementById("clusterHoverPopover")?.classList.remove("active");
        document.querySelectorAll(".scan-cluster-blob").forEach((b) => b.classList.remove("active-cluster"));
        if (gsMap) {
          gsMap.selectedGroup = null;
          fitMapToAllGeorefGroups();
          gsMap.drawMap();
        }
        openSiteTimeline("__all__");
        return;
      }
      const grp = getProjectGroupsList("").find((g) => g.project_group === val);
      if (grp && gsMap && grp.hasGeoref && Number.isFinite(grp.lat) && Number.isFinite(grp.lon)) {
        gsMap.centerLat = grp.lat;
        gsMap.centerLon = grp.lon;
        gsMap.zoom = Math.max(gsMap.zoom || 12, 13.8);
      }
      openSiteTimeline(val);
    }
  });

  document.getElementById("studioProjectSelect")?.addEventListener("change", (e) => {
    const newGrp = e.target.value;
    if (!newGrp) return;
    STATE.activeProjectGroup = newGrp;
    populateProjectScanDropdowns(newGrp);
    const firstScan = STATE.scans.find((s) => s.project_group === newGrp);
    if (firstScan) {
      loadScanIntoStudio(firstScan.scan_id);
    }
  });

  document.getElementById("studioScanSelect")?.addEventListener("change", (e) => {
    if (e.target.value) {
      loadScanIntoStudio(e.target.value);
    }
  });

  document.getElementById("compareProjectSelect")?.addEventListener("change", (e) => {
    const newGrp = e.target.value;
    if (!newGrp) return;
    STATE.activeProjectGroup = newGrp;
    populateProjectScanDropdowns(newGrp);
    syncCompareScansFromDropdowns();
    showToast(`Switched Multi-Date Compare to project: ${newGrp}`);
  });

  function switchView(viewName, optionalScanId = null) {
    if (viewName !== "studio" && STATE.fpMode?.active && typeof exitFirstPersonMode === "function") {
      exitFirstPersonMode(true);
    }
    if (viewName !== "studio" && STATE.multiAlign?.active && typeof exitMultiScanAlignMode === "function") {
      exitMultiScanAlignMode(false);
    }
    STATE.activeView = viewName;
    SHARE_TELEMETRY.recordViewSwitch(viewName);
    document.querySelectorAll("#mainModeSwitcher .btn-seg").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === viewName);
    });
    document.getElementById("viewMap")?.classList.toggle("active", viewName === "map");
    document.getElementById("viewStudio")?.classList.toggle("active", viewName === "studio");
    document.getElementById("viewCompare")?.classList.toggle("active", viewName === "compare");

    if (viewName === "map") {
      document.getElementById("siteTimelineSplitView")?.classList.add("active");
      setTimeout(() => {
        if (gsMap && gsMap.drawMap) gsMap.drawMap();
        syncPreviewRendererContainer();
      }, 60);
    } else if (viewName === "studio") {
      initStudio3D();
      handleResize();
      loadScanIntoStudio(optionalScanId || STATE.activeScanId);
    } else if (viewName === "compare") {
      populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);
      initCompareView();
      handleResize();
      syncCompareScansFromDropdowns();
    }
  }

  document.querySelectorAll("#mainModeSwitcher .btn-seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchView(btn.dataset.view);
    });
  });

  function handleResize() {
    if (gsMap && gsMap.drawMap && STATE.activeView === "map") {
      gsMap.drawMap();
    }
    if (previewThree && STATE.activeView === "map") {
      syncPreviewRendererContainer();
    }
    if (studioThree && STATE.activeView === "studio") {
      const w = Math.max(1, studioThree.container.clientWidth);
      const h = Math.max(1, studioThree.container.clientHeight);
      studioThree.camera.aspect = w / h;
      studioThree.camera.updateProjectionMatrix();
      studioThree.renderer.setSize(w, h);
      if (studioThree.tilesRenderer) {
        studioThree.tilesRenderer.setResolutionFromRenderer(studioThree.camera, studioThree.renderer);
      }
    }
    if (compareCtx && STATE.activeView === "compare") {
      const stage = document.getElementById("compareStage");
      const stageW = Math.max(2, Number(stage?.clientWidth) || Number(compareCtx.left?.container?.clientWidth) || window.innerWidth);
      const stageH = Math.max(1, Number(stage?.clientHeight) || Number(compareCtx.left?.container?.clientHeight) || window.innerHeight - 52);
      const w = STATE.compareMode === "split" ? Math.max(1, Math.floor(stageW / 2)) : stageW;
      const h = stageH;
      [compareCtx.left, compareCtx.right].forEach((side) => {
        if (!side) return;
        side.camera.aspect = w / h;
        side.camera.updateProjectionMatrix();
        side.renderer.setSize(w, h);
        if (side.tilesRenderer) {
          side.tilesRenderer.setResolutionFromRenderer(side.camera, side.renderer);
        }
      });
    }
  }

  window.addEventListener("resize", handleResize);

  async function refreshScansCatalog(isBackgroundPoll = false) {
    try {
      if (
        isBackgroundPoll &&
        ((previewThree && !previewThree._loadingDone) || (studioThree && !studioThree._loadingDone))
      ) {
        return;
      }
      const prevCatalogSig = (STATE.scans || [])
        .map(
          (s) =>
            `${s.scan_id}:${s.name}:${s.project_group}:${s.status}:${Math.round(s.progress_pct || 0)}:${s.stream_url || ""}:${s.preview_stream_url || ""}`
        )
        .join("|");
      const data = await apiGet(isBackgroundPoll ? "/api/scans?bg=1" : "/api/scans");
      const normalizeScanUploader = (s) => {
        if (!s) return s;
        if (s.uploader_name === "Glib Ivanov" || s.uploader_name === "Argon") {
          s.uploader_name = "雲在天";
        } else if (!s.uploader_name) {
          s.uploader_name = "Field Team";
        }
        if (s.uploader_email === "glib@gatheren.com.tw" || s.uploader_email === "argon@gatheren.com.tw") {
          s.uploader_email = "glibivanov@gatheren.com.tw";
        } else if (!s.uploader_email) {
          s.uploader_email = "";
        }
        return s;
      };
      const incomingScans = (Array.isArray(data.scans) ? data.scans : []).map(normalizeScanUploader);

      if (incomingScans.length > 0) {
        STATE.scans = incomingScans;
        STATE.projects = data.projects || [];
        try {
          localStorage.setItem(
            "gs_last_catalog_v1",
            JSON.stringify({ scans: STATE.scans, projects: STATE.projects })
          );
        } catch (_) {}
      } else if (data.pc_online === false) {
        // Never wipe existing timeline scans on a transient tunnel reconnect
        if (!STATE.scans || STATE.scans.length === 0) {
          try {
            const cached = JSON.parse(localStorage.getItem("gs_last_catalog_v1") || "null");
            if (cached && Array.isArray(cached.scans) && cached.scans.length > 0) {
              STATE.scans = cached.scans.map(normalizeScanUploader);
              STATE.projects = cached.projects || [];
            }
          } catch (_) {}
        }
      } else {
        STATE.scans = incomingScans;
        STATE.projects = data.projects || [];
      }

      if (data.materials) {
        STATE.materials = data.materials;
      }
      if (typeof data.pc_online === "boolean") {
        STATE.pcOnline = data.pc_online;
        updatePcStatusUI();
      }
      if (typeof data.bin_scans_count === "number") {
        updateRecycleBinBadges(data.bin_scans_count);
      }
      if (data.user_settings && data.user_settings.theme_preference && !localStorage.getItem("gs_theme_pref")) {
        await applyTheme(data.user_settings.theme_preference, false);
      }

      if (data.mode === "external_share" && data.share_link) {
        STATE.shareLinkInfo = data.share_link;
        const banner = document.getElementById("externalShareBanner");
        const scopeLbl = document.getElementById("lblExternalShareScope");
        if (banner && scopeLbl) {
          banner.style.display = "flex";
          const friendlyScope = resolveShareScopeTitle(data.share_link.scope_type, data.share_link.target_id);
          const linkPerms = [
            "3D View",
            data.share_link.allow_measurements ? "Measurements" : null,
            data.share_link.allow_comments ? "3D Comments" : null,
            data.share_link.allow_download ? "Download" : null,
          ]
            .filter(Boolean)
            .join(" + ");
          scopeLbl.textContent = `${data.share_link.label} (${String(data.share_link.scope_type || "scan").toUpperCase()}: ${friendlyScope}) — ${linkPerms}`;
        }
        const viewerNameInp = document.getElementById("inpShareViewerName");
        if (viewerNameInp && !viewerNameInp.dataset.boundTelemetry) {
          viewerNameInp.dataset.boundTelemetry = "1";
          try {
            const savedName = (localStorage.getItem("gs_guest_comment_author") || "").trim();
            if (savedName) viewerNameInp.value = savedName;
          } catch (_) {}
          const commitViewerName = () => {
            const nm = viewerNameInp.value.trim();
            if (nm) {
              SHARE_TELEMETRY.setViewerName(nm);
            }
          };
          viewerNameInp.addEventListener("change", commitViewerName);
          viewerNameInp.addEventListener("blur", commitViewerName);
          viewerNameInp.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
              ev.preventDefault();
              viewerNameInp.blur();
            }
          });
        }
        applyRolePermissionsToUI();
      }

      const nextCatalogSig = (STATE.scans || [])
        .map(
          (s) =>
            `${s.scan_id}:${s.name}:${s.project_group}:${s.status}:${Math.round(s.progress_pct || 0)}:${s.stream_url || ""}:${s.preview_stream_url || ""}`
        )
        .join("|");

      if (isBackgroundPoll && prevCatalogSig === nextCatalogSig) {
        return;
      }

      // Dynamically resolve initial project & scan from URL params on initial load only
      const params = new URLSearchParams(window.location.search);
      const urlProject = params.get("project");
      const urlScan = params.get("scan");
      if (!isBackgroundPoll && urlScan && STATE.scans.some((s) => s.scan_id === urlScan)) {
        STATE.activeScanId = urlScan;
      } else if (!STATE.activeScanId || !STATE.scans.some((s) => s.scan_id === STATE.activeScanId)) {
        if (STATE.scans.length > 0) {
          const firstReady = STATE.scans.find((s) => s.status === "completed") || STATE.scans[0];
          STATE.activeScanId = firstReady.scan_id;
        }
      }
      if (
        !STATE.selectedTimelineScanId ||
        !STATE.scans.some((s) => s.scan_id === STATE.selectedTimelineScanId)
      ) {
        STATE.selectedTimelineScanId = STATE.activeScanId;
      }

      const activeScanObj =
        STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || STATE.scans[0];
      if (!isBackgroundPoll && urlProject && STATE.scans.some((s) => s.project_group === urlProject)) {
        STATE.activeProjectGroup = urlProject;
      } else if (
        STATE.activeProjectGroup !== "__all__" &&
        (!STATE.activeProjectGroup ||
          !STATE.scans.some((s) => s.project_group === STATE.activeProjectGroup))
      ) {
        if (activeScanObj && activeScanObj.project_group) {
          STATE.activeProjectGroup = activeScanObj.project_group;
        }
      }
      populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);
      renderMapClusters();

      if (prevCatalogSig !== nextCatalogSig && STATE.siteTimelineOpen && STATE.activeView === "map" && STATE.scans.length > 0) {
        openSiteTimeline(STATE.activeProjectGroup, STATE.selectedTimelineScanId, false);
      }
    } catch (err) {
      const errMsg = String(err?.message || "");
      const isRevokedShare =
        Boolean(STATE.shareToken) &&
        (errMsg.toLowerCase().includes("revoked") ||
          errMsg.toLowerCase().includes("invalid") ||
          errMsg.includes("403"));
      // Try offline cached catalog only when NOT an invalid/revoked share token
      if (!isRevokedShare && (!STATE.scans || STATE.scans.length === 0)) {
        try {
          const cached = JSON.parse(localStorage.getItem("gs_last_catalog_v1") || "null");
          if (cached && Array.isArray(cached.scans) && cached.scans.length > 0) {
            STATE.scans = cached.scans;
            STATE.projects = cached.projects || [];
            populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);
            renderMapClusters();
            if (!isBackgroundPoll) {
              showToast("Offline Mode: Loaded scans from local browser cache");
            }
            return;
          }
        } catch (_) {}
      }
      if (isRevokedShare && (!STATE.scans || STATE.scans.length === 0)) {
        document.body.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:var(--ui-bg-subtle);color:var(--ui-text-primary);font-family:sans-serif;padding:24px;">
            <div style="max-width:480px;background:var(--ui-bg-surface);border:1px solid var(--ui-border-strong);border-radius:12px;padding:24px;text-align:center;box-shadow:var(--ui-shadow-window);">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="var(--ui-accent)" stroke-width="1.8" style="margin-bottom:10px;">
                <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              <h2 style="font-size:17px;color:var(--ui-text-primary);">Access Restricted or Link Revoked</h2>
              <p style="font-size:13px;color:var(--ui-text-secondary);margin-top:8px;">${escapeHtml(errMsg)}</p>
            </div>
          </div>
        `;
      } else if (!isBackgroundPoll) {
        showToast(`Catalog sync note: ${errMsg}`);
      }
    }
  }

  // Bootstrap Application, Theme Engine (Default: Time of Day Auto) & Mandatory Authorization Gate
  window.addEventListener("DOMContentLoaded", async () => {
    const topBadge = document.getElementById("topCrsBadge");
    if (topBadge) {
      topBadge.textContent = "Created by Glib Ivanov, PhD and Gemini 4 Argon";
      topBadge.title = "Created by Glib Ivanov, PhD and Gemini 4 Argon";
    }
    await applyTheme(STATE.themePreference, false);
    applyUserProfileToUI(STATE.currentUser, false);
    if (!STATE.isAuthorized && !STATE.shareToken) {
      document.body.classList.add("gs-auth-locked");
      openUserProfileGateModal();
    } else {
      loadTeamUserProfiles();
    }
    await refreshScansCatalog(false);
    const urlScan = new URLSearchParams(window.location.search).get("scan");
    if (urlScan) {
      switchView("studio", urlScan);
    } else if (
      STATE.shareToken &&
      String(STATE.shareLinkInfo?.scope_type || "").toLowerCase() === "scan" &&
      STATE.activeScanId
    ) {
      switchView("studio", STATE.activeScanId);
    }
    window.addEventListener("focus", () => {
      refreshScansCatalog(true);
      if (STATE.themePreference === "auto") {
        applyTheme("auto", false);
      }
    });
    setInterval(() => {
      refreshScansCatalog(true);
    }, 4000);
    setInterval(() => {
      if (STATE.themePreference === "auto") {
        applyTheme("auto", false);
      }
    }, 60000);
    setInterval(() => {
      try {
        if (STATE.activeView === "map" && previewThree && previewThree.tilesRenderer && !previewThree._loadingDone) {
          previewThree.camera.updateMatrixWorld();
          previewThree.tilesRenderer.update();
          syncTilesLoaderProgress(previewThree, "preview");
          previewThree.renderer.render(previewThree.scene, previewThree.camera);
        }
        if (STATE.activeView === "studio" && studioThree && studioThree.tilesRenderer && !studioThree._loadingDone) {
          studioThree.camera.updateMatrixWorld();
          studioThree.tilesRenderer.update();
          syncTilesLoaderProgress(studioThree, "studio");
          studioThree.renderer.render(studioThree.scene, studioThree.camera);
        }
        if (STATE.activeView === "compare" && compareCtx && !compareCtx._loadingDone) {
          let needsRender = false;
          ["left", "right"].forEach((k) => {
            const side = compareCtx[k];
            if (side && side.tilesRenderer) {
              side.camera.updateMatrixWorld();
              side.tilesRenderer.update();
              needsRender = true;
            }
          });
          syncCompareLoaderProgress();
          if (needsRender && compareCtx.left && compareCtx.right) {
            compareCtx.left.renderer.render(compareCtx.left.scene, compareCtx.left.camera);
            compareCtx.right.renderer.render(compareCtx.right.scene, compareCtx.right.camera);
          }
        }
      } catch (_) {}
    }, 120);
  });

  // Guard against any stale cached stylesheet missing post-v41 Studio Dock / Modal / Flex Badge rules
  const ensureStudioStylesheetIntegrity = () => {
    const editDock = document.getElementById("studioEditingDock");
    const sampleModalWin = document.querySelector(".gs-modal-window");
    const dockBroken =
      editDock &&
      window.getComputedStyle(editDock).position !== "absolute" &&
      window.getComputedStyle(editDock).position !== "fixed";
    const modalBroken =
      sampleModalWin &&
      (window.getComputedStyle(sampleModalWin).backgroundColor === "rgba(0, 0, 0, 0)" ||
        window.getComputedStyle(sampleModalWin).backgroundColor === "transparent");
    if (dockBroken || modalBroken) {
      const freshLink = document.createElement("link");
      freshLink.rel = "stylesheet";
      freshLink.href = `/app.css?fresh=${Date.now()}`;
      document.head.appendChild(freshLink);
    }
  };
  if (document.readyState === "complete") {
    setTimeout(ensureStudioStylesheetIntegrity, 80);
  } else {
    window.addEventListener("load", () => setTimeout(ensureStudioStylesheetIntegrity, 80), { once: true });
  }

  window.__GS_API = {
    STATE,
    getContexts: () => ({ previewThree, studioThree, compareCtx }),
    switchView,
    openSiteTimeline,
    selectTimelineTile,
    launchMultiDateCompare,
    loadScanIntoCompareSide,
    setCompareMode,
    frameCompareCamera,
    setCompareElevationHeatmap,
    alignCompareSides,
    refreshScansCatalog,
    drawA3PreviewCanvas,
    openOptimizerInspector,
    cancelLassoToolMode,
    setActiveStudioTool,
    rebuildLassoHighlight3D,
    clearLassoSelectionState,
    buildStudioLassoFrustumStroke,
    enterFirstPersonMode,
    exitFirstPersonMode,
    toggleFirstPersonMode,
    setFirstPersonLocomotion,
    openCategorizeInspector,
    setCategorizeOverlayVisibility,
    preloadSavedCategorizationForScan,
    syncCategorizeVisibilityUI,
  };
})();


