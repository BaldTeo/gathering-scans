/**
 * GatheringScans Frontend Module 08 (Bootstrap) — Scoped External Sharing, Offline/Admin Control Panel, Google OAuth Gate & View Navigation
 */
"use strict";


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

  function buildPublicEmbedUrl(token, opts = {}) {
    const cleanTok = encodeURIComponent(String(token || "").trim());
    const mode = opts.poster ? "poster" : "1";
    const lod = opts.lod || "auto";
    const qs = new URLSearchParams();
    if (mode === "poster") qs.set("embed", "poster");
    if (lod && lod !== "auto") qs.set("lod", lod);
    if (opts.scanId) qs.set("scan", String(opts.scanId));
    const qStr = qs.toString();
    return `${getPublicShareOrigin()}/embed/${cleanTok}${qStr ? `?${qStr}` : ""}`;
  }

  function buildHostingerEmbedCode(token, title = "GatheringCloud 3D Scan", opts = {}) {
    const origin = getPublicShareOrigin();
    const embedUrl = buildPublicEmbedUrl(token, opts);
    const safeTitle = String(title || "GatheringCloud 3D Scan").replace(/"/g, "&quot;");
    const heightPx = Number(opts.height) > 200 ? Number(opts.height) : 620;
    return [
      `<!-- GatheringCloud Instant 3D Scan Embed (Hostinger Website Builder HTML Block) -->`,
      `<link rel="preconnect" href="${origin}" crossorigin />`,
      `<link rel="dns-prefetch" href="${origin}" />`,
      `<div style="position:relative;width:100%;height:${heightPx}px;min-height:420px;border-radius:14px;overflow:hidden;background:#0f172a;box-shadow:0 12px 32px rgba(0,0,0,0.24);">`,
      `  <iframe`,
      `    src="${embedUrl}"`,
      `    title="${safeTitle}"`,
      `    style="position:absolute;inset:0;width:100%;height:100%;border:0;"`,
      `    loading="eager"`,
      `    fetchpriority="high"`,
      `    allow="fullscreen; xr-spatial-tracking; accelerometer; gyroscope; clipboard-write"`,
      `    allowfullscreen`,
      `  ></iframe>`,
      `</div>`,
    ].join("\n");
  }
  window.buildPublicEmbedUrl = buildPublicEmbedUrl;
  window.buildHostingerEmbedCode = buildHostingerEmbedCode;

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
      <span>${tr("已複製！", "Copied!")}</span>
    `;
    if (btnEl._copyTimer) clearTimeout(btnEl._copyTimer);
    btnEl._copyTimer = setTimeout(() => {
      btnEl.classList.remove("is-copied");
      if (btnEl.dataset.origHtml) {
        btnEl.innerHTML = btnEl.dataset.origHtml;
      }
    }, 2200);
  }

  function showLatestShareLinkBanner(url, statusLabel = tr("分享連結已就緒：", "Shareable Link Ready:")) {
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
      showLatestShareLinkBanner(buildPublicShareUrl(activeMatch.token), tr("分享連結已就緒：", "Shareable Link Ready:"));
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
  document.getElementById("btnCopyLatestShareEmbed")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const inp = document.getElementById("shareLatestUrlInput");
    const url = inp?.value || "";
    const tokMatch = url.match(/\/(?:s|embed)\/([^/?#]+)/) || url.match(/[?&]share=([^&#]+)/);
    const tok = tokMatch ? decodeURIComponent(tokMatch[1]) : "";
    if (!tok) return;
    const scopeSel = document.getElementById("shareScopeType");
    const targetSel = document.getElementById("shareTargetId");
    const title = resolveShareScopeTitle(scopeSel?.value || "scan", targetSel?.value || STATE.activeScanId);
    const snippet = buildHostingerEmbedCode(tok, title);
    await copyTextToClipboard(snippet);
    flashCopyButtonState(btn);
    showToast(tr("已複製 Hostinger HTML 嵌入程式碼！可直接貼上至網站建置器。", "Copied Hostinger HTML Embed Code! Paste into an Embed Code block."));
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
    if (!k) return tr("工具", "Tool");
    const zhMap = {
      orbit: "3D 旋轉／縮放",
      first_person_fly: "第一人稱飛行",
      first_person_walk: "第一人稱步行",
      comments: "3D 空間留言",
      comment_posted: "發佈留言",
      distance: "距離測量",
      area: "多邊形面積",
      coordinates: "座標點位",
      angle: "3D 夾角",
      laser: "雷射跨距",
      volume: "土方挖填體積",
      contours: "等高線與 DXF",
      profile: "高程縱斷面",
      section: "3D 剖切盒",
      photos: "RTK 相機點位",
      compare_slider: "多期別分割比對",
      download_3tz: "下載 .3TZ",
      download_glb: "下載 .GLB",
      download_obj: "下載 .OBJ",
      download_zip: "下載 .ZIP",
    };
    if (window.getAppLanguage?.() !== "en" && zhMap[k]) return zhMap[k];
    if (SHARE_TOOL_LABELS[k]) return SHARE_TOOL_LABELS[k];
    if (k.startsWith("download_")) return `${tr("下載", "Download")} .${k.slice(9).toUpperCase()}`;
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
    listBox.innerHTML = `<div style="font-size:11.5px;color:var(--ui-text-muted);padding:8px 2px;">${tr("正在載入訪客遙測與工具互動紀錄...", "Loading visitor telemetry & tool engagement...")}</div>`;

    try {
      const res = await apiGet(`/api/share/analytics?token=${encodeURIComponent(cleanTok)}&limit=150`);
      if (_activeAnalyticsToken !== cleanTok) return;
      const link = res.link || {};
      const summary = res.summary || {};
      const sessions = Array.isArray(res.sessions) ? res.sessions : [];

      const scopeKind = String(link.scope_type || "scan").toUpperCase();
      const friendlyTarget = link.target_id ? resolveShareScopeTitle(link.scope_type, link.target_id) : cleanTok;
      if (titleEl) {
        titleEl.textContent = `${link.label || friendlyTarget} — ${tr("訪客與工具使用統計", "Visitor & Tool Analytics")}`;
      }
      if (subEl) {
        const lastStr = summary.last_viewed_at
          ? tr(`最後瀏覽：${summary.last_viewed_at}`, `Last viewed: ${summary.last_viewed_at}`)
          : tr("尚無訪客瀏覽紀錄", "No human sessions recorded yet");
        subEl.textContent = `${scopeKind}: ${friendlyTarget} · ${tr("建立時間", "Created")} ${link.created_at || "—"} · ${lastStr}`;
      }

      const humanOpens = Math.max(Number(link.human_views ?? link.view_count ?? 0), Number(summary.recorded_sessions || 0));
      const topTools = Array.isArray(summary.top_tools) ? summary.top_tools : [];
      const topToolFirst = topTools[0] || null;
      const topToolLabel = topToolFirst ? formatToolNameFriendly(topToolFirst.tool) : "—";
      const topToolSub = topToolFirst
        ? tr(
            `${topToolFirst.seconds >= 1 ? formatDurationCompact(topToolFirst.seconds) + " 互動 · " : ""}${topToolFirst.uses || 1} 次 · ${topToolFirst.sessions || 1} 個工作階段`,
            `${topToolFirst.seconds >= 1 ? formatDurationCompact(topToolFirst.seconds) + " engaged · " : ""}${topToolFirst.uses || 1}x across ${topToolFirst.sessions || 1} session${(topToolFirst.sessions || 1) === 1 ? "" : "s"}`
          )
        : tr("等待工具互動紀錄", "Waiting for tool activity");

      const totalActions =
        Number(summary.measurements_total || 0) +
        Number(summary.comments_posted_total || 0) +
        Number(summary.downloads_total || 0);

      kpiGrid.innerHTML = `
        <div class="gs-analytics-kpi-card">
          <div class="k-lbl">${tr("真人開啟次數", "Human Opens")}</div>
          <div class="k-val">${humanOpens}</div>
          <div class="k-sub">${tr(`已追蹤 ${Number(summary.recorded_sessions || 0)} 個工作階段`, `${Number(summary.recorded_sessions || 0)} tracked sessions`)}</div>
        </div>
        <div class="gs-analytics-kpi-card">
          <div class="k-lbl">${tr("不重複訪客", "Unique Visitors")}</div>
          <div class="k-val">${Number(summary.unique_visitors || 0)}</div>
          <div class="k-sub">${tr(`${Number(summary.bot_unfurls || 0)} 次連結預覽`, `${Number(summary.bot_unfurls || 0)} chat link previews`)}</div>
        </div>
        <div class="gs-analytics-kpi-card">
          <div class="k-lbl">${tr("平均操作時間", "Avg Active Time")}</div>
          <div class="k-val">${escapeHtml(formatDurationCompact(summary.avg_active_sec || 0))}</div>
          <div class="k-sub">${tr("累計互動：", "Total engaged: ")}${escapeHtml(formatDurationCompact(summary.total_active_sec || 0))}</div>
        </div>
        <div class="gs-analytics-kpi-card">
          <div class="k-lbl">${tr("分頁開啟總時長", "Total Tab Open")}</div>
          <div class="k-val">${escapeHtml(formatDurationCompact(summary.total_open_sec || 0))}</div>
          <div class="k-sub">${tr("前景 + 背景", "Foreground + background")}</div>
        </div>
        <div class="gs-analytics-kpi-card">
          <div class="k-lbl">${tr("空間操作總數", "Spatial Actions")}</div>
          <div class="k-val">${totalActions}</div>
          <div class="k-sub">${tr(`${Number(summary.comments_posted_total || 0)} 留言 · ${Number(summary.measurements_total || 0)} 測量 · ${Number(summary.downloads_total || 0)} 下載`, `${Number(summary.comments_posted_total || 0)} cmts · ${Number(summary.measurements_total || 0)} meas · ${Number(summary.downloads_total || 0)} dl`)}</div>
        </div>
        <div class="gs-analytics-kpi-card">
          <div class="k-lbl">${tr("最常使用工具", "Most Used Tool")}</div>
          <div class="k-val" style="font-size:12.5px;">${escapeHtml(topToolLabel)}</div>
          <div class="k-sub">${escapeHtml(topToolSub)}</div>
        </div>
      `;

      if (!sessions.length) {
        listBox.innerHTML = `
          <div style="font-size:11.5px;color:var(--ui-text-muted);padding:10px 12px;border:1px dashed var(--ui-border-strong);border-radius:8px;">
            ${tr("此連結尚無訪客工作階段或預覽紀錄。分享", "No visitor sessions or link previews recorded yet for this link. Share")} <code>${escapeHtml(buildPublicShareUrl(cleanTok))}</code> ${tr("即可即時查看訪客來源、裝置與使用的 3D 工具。", "to see live viewer telemetry.")}
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
            : tr(`訪客 #${shortVid || "guest"}`, `Visitor #${shortVid || "guest"}`);
          const emailBadge =
            s.viewer_email && s.viewer_email !== displayWho
              ? `<span style="font-size:10.5px;color:var(--ui-text-muted);font-weight:500;">· ${escapeHtml(s.viewer_email)}</span>`
              : "";
          const liveBadge = isLiveNow
            ? `<span class="gs-crs-pill" style="background:rgba(16,185,129,0.16);color:#10b981;border-color:rgba(16,185,129,0.45);font-size:9.5px;">${tr("線上瀏覽中", "LIVE NOW")}</span>`
            : `<span class="gs-crs-pill" style="font-size:9.5px;">#${escapeHtml(shortVid)}</span>`;

          const loadSummary =
            Number(s.max_load_pct || 0) > 0
              ? `${Math.round(Number(s.max_load_pct))}%${Number(s.load_time_ms || 0) > 0 ? ` · ${(Number(s.load_time_ms) / 1000).toFixed(1)}s` : ""}`
              : "—";

          const deviceSummary = [s.device_type, s.os, s.browser].filter(Boolean).join(" · ") || tr("瀏覽器", "Browser");
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
              return `<span class="gs-analytics-tool-pill" style="border-color:var(--ui-accent);color:var(--ui-accent);">${tr("掃描：", "Scan: ")}<b>${escapeHtml(nm)}</b></span>`;
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
              ? `<span class="gs-analytics-tool-pill">${tr("視角移動", "Camera Moves")} <b>${Number(s.camera_interactions)}</b></span>`
              : "",
            Number(s.fp_seconds || 0) >= 1
              ? `<span class="gs-analytics-tool-pill">${tr("第一人稱", "First-Person")} <b>${escapeHtml(formatDurationCompact(s.fp_seconds))}</b></span>`
              : "",
            Number(s.measurements_count || 0) > 0
              ? `<span class="gs-analytics-tool-pill">${tr("測量", "Measurements")} <b>${Number(s.measurements_count)}</b></span>`
              : "",
            Number(s.comments_posted || 0) > 0
              ? `<span class="gs-analytics-tool-pill" style="border-color:#10b981;color:#10b981;">${tr("發佈留言", "Comments Posted")} <b>${Number(s.comments_posted)}</b></span>`
              : "",
            Number(s.downloads_count || 0) > 0
              ? `<span class="gs-analytics-tool-pill">${tr("下載", "Downloads")} <b>${Number(s.downloads_count)}</b></span>`
              : "",
          ]
            .filter(Boolean)
            .join("");

          const evList = Array.isArray(s.events) ? s.events : [];
          const timelineHtml = evList.length
            ? `
              <details class="gs-analytics-timeline">
                <summary>${tr(`工作階段活動時間軸 · ${evList.length} 筆事件`, `Session Activity Timeline · ${evList.length} event${evList.length === 1 ? "" : "s"}`)}</summary>
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
                  <span>${tr("操作時長：", "Active: ")}<b style="color:var(--ui-accent);">${escapeHtml(formatDurationCompact(s.active_duration_sec || 0))}</b></span>
                  <span>${tr("分頁開啟：", "Tab Open: ")}<b style="color:var(--ui-text-primary);">${escapeHtml(formatDurationCompact(s.total_duration_sec || 0))}</b></span>
                  <span>${tr("3D 載入：", "3D Load: ")}<b style="color:var(--ui-text-primary);">${escapeHtml(loadSummary)}</b></span>
                  <span style="color:var(--ui-text-muted);">${escapeHtml(s.started_at || "")}</span>
                </div>
              </div>
              <div class="gs-analytics-meta-row">
                <span><b>${tr("位置：", "Location:")}</b> ${escapeHtml(locStr + ispStr)}</span>
                <span><b>IP:</b> <code>${escapeHtml(ipStr)}</code></span>
                <span><b>${tr("裝置：", "Device:")}</b> ${escapeHtml(deviceSummary)}</span>
                ${screenSummary ? `<span><b>${tr("螢幕：", "Display:")}</b> ${escapeHtml(screenSummary)}</span>` : ""}
                ${localeSummary ? `<span><b>${tr("語系：", "Locale:")}</b> ${escapeHtml(localeSummary)}</span>` : ""}
                ${s.connection_type ? `<span><b>${tr("網路：", "Net:")}</b> ${escapeHtml(s.connection_type)}</span>` : ""}
                ${s.gpu_renderer ? `<span title="${escapeHtml(s.gpu_renderer)}"><b>GPU:</b> ${escapeHtml(String(s.gpu_renderer).slice(0, 56))}</span>` : ""}
                ${s.referrer ? `<span><b>${tr("來源：", "Referrer:")}</b> ${escapeHtml(String(s.referrer).slice(0, 64))}</span>` : ""}
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
          opt.textContent = `${s.name} · ${s.project_group}`;
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
        tbody.innerHTML = `<tr><td colspan="7" style="color:var(--ui-text-muted);">${tr("尚無對外分享連結。請點擊上方「建立並複製連結」以產生分享網址。", 'No external share links created yet. Click "Create & Copy Link" above to generate a shareable URL.')}</td></tr>`;
        if (!preferredBannerUrl) showLatestShareLinkBanner("");
        return;
      }
      links.forEach((l) => {
        const rowEl = document.createElement("tr");
        const perms = [
          l.allow_measurements ? tr("測量", "Measure") : null,
          l.allow_comments ? tr("留言", "Comment") : null,
          l.allow_download ? tr("下載", "Download") : null,
        ]
          .filter(Boolean)
          .join(", ");
        const safeToken = escapeHtml(l.token || "");
        const fullShareUrl = buildPublicShareUrl(l.token || "");
        const safeFullUrl = escapeHtml(fullShareUrl);
        const scopeKind = String(l.scope_type || "scan").toUpperCase();
        const friendlyTarget = resolveShareScopeTitle(l.scope_type, l.target_id);
        const fullScopeTooltip = `${scopeKind}: ${friendlyTarget}${friendlyTarget !== l.target_id ? ` · ${l.target_id}` : ""}`;

        const humanViews = Number(l.human_views ?? l.view_count ?? 0);
        const uniqVisitors = Number(l.unique_visitors || 0);
        const avgSec = Number(l.avg_active_sec || 0);
        const botUnfurls = Number(l.bot_unfurls || 0);
        const subStats = [
          uniqVisitors > 0 ? tr(`${uniqVisitors} 位訪客`, `${uniqVisitors} visitor${uniqVisitors === 1 ? "" : "s"}`) : null,
          avgSec > 0 ? `${tr("平均", "Avg")} ${formatDurationCompact(avgSec)}` : null,
          botUnfurls > 0 ? tr(`${botUnfurls} 次預覽`, `${botUnfurls} preview${botUnfurls === 1 ? "" : "s"}`) : null,
        ]
          .filter(Boolean)
          .join(" · ");

        rowEl.innerHTML = `
          <td><b style="color:var(--ui-text-primary);">${escapeHtml(l.label || "")}</b></td>
          <td>
            <span class="gs-crs-pill gs-share-scope-pill" title="${escapeHtml(fullScopeTooltip)}">
              <span class="gs-share-scope-pill-text">${escapeHtml(scopeKind)}: ${escapeHtml(friendlyTarget)}</span>
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
              <button type="button" class="btn-xs primary gs-share-copy-btn" data-copy="${safeFullUrl}" title="${tr("複製完整分享連結", "Copy Full Share Link")}">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                <span>${tr("複製", "Copy")}</span>
              </button>
              <button type="button" class="btn-xs gs-share-embed-btn" data-copy-embed="${safeToken}" title="${tr("複製 Hostinger 網站嵌入程式碼 (HTML)", "Copy Hostinger Website Builder Embed Code (HTML)")}">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                </svg>
                <span>${tr("嵌入", "Embed")}</span>
              </button>
              <a href="${safeFullUrl}" target="_blank" rel="noopener noreferrer" class="btn-xs gs-share-open-btn" title="${tr("於新分頁開啟分享連結", "Open Share Link in New Tab")}">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              </a>
            </div>
          </td>
          <td style="font-size:11px;color:var(--ui-text-secondary);white-space:nowrap;">${escapeHtml(perms || tr("僅檢視", "View"))}</td>
          <td style="white-space:nowrap;">
            <div style="font-size:11.5px;font-weight:700;color:var(--ui-text-primary);">${tr(`${humanViews} 次瀏覽`, `${humanViews} view${humanViews === 1 ? "" : "s"}`)}</div>
            <div style="font-size:10px;color:var(--ui-text-muted);">${escapeHtml(subStats || tr("尚無遙測紀錄", "No telemetry yet"))}</div>
          </td>
          <td>${
            l.revoked
              ? `<span style="color:var(--ui-text-muted);font-weight:700;font-size:11px;">${tr("已撤銷", "REVOKED")}</span>`
              : `<span class="gs-crs-pill">${tr("有效", "ACTIVE")}</span>`
          }</td>
          <td style="display:flex;gap:5px;justify-content:flex-end;align-items:center;">
            <button type="button" class="btn-xs" data-analytics="${safeToken}" title="${tr("檢視訪客工作階段、停留時間、裝置與使用的 3D 工具", "Inspect Visitor Sessions, Active Time, Devices & Tools Used")}">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.9">
                <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
              </svg>
              <span>${tr("統計", "Analytics")}</span>
            </button>
            ${
              !canManageLinks
                ? ""
                : !l.revoked
                ? `<button type="button" class="btn-xs" data-revoke="${safeToken}" title="${tr("立即撤銷存取權限", "Revoke Access Immediately")}">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                      <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
                    </svg>
                  </button>`
                : `<button type="button" class="btn-xs" data-restore="${safeToken}" title="${tr("恢復存取權限", "Restore Access")}">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
                      <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                    </svg>
                  </button>`
            }
          </td>
        `;
        const urlInp = rowEl.querySelector(".gs-share-url-input");
        urlInp?.addEventListener("click", () => {
          urlInp.select();
        });
        const copyBtn = rowEl.querySelector("[data-copy]");
        copyBtn?.addEventListener("click", async () => {
          await copyTextToClipboard(fullShareUrl);
          urlInp?.select?.();
          flashCopyButtonState(copyBtn);
          showLatestShareLinkBanner(fullShareUrl, tr("已複製到剪貼簿：", "Copied to Clipboard:"));
          showToast(tr(`已複製分享連結：${fullShareUrl}`, `Copied share link: ${fullShareUrl}`));
        });
        const copyEmbedBtn = rowEl.querySelector("[data-copy-embed]");
        copyEmbedBtn?.addEventListener("click", async () => {
          const snippet = buildHostingerEmbedCode(l.token, friendlyTarget);
          await copyTextToClipboard(snippet);
          flashCopyButtonState(copyEmbedBtn);
          showToast(tr(`已複製「${friendlyTarget}」的 Hostinger 嵌入程式碼！`, `Copied Hostinger HTML Embed code for "${friendlyTarget}"!`));
        });
        rowEl.querySelector("[data-analytics]")?.addEventListener("click", () => {
          openShareAnalyticsDrawer(l.token);
        });
        rowEl.querySelector("[data-revoke]")?.addEventListener("click", async () => {
          await apiPost("/api/share/revoke", { token: l.token });
          showToast(tr(`已撤銷外部分享連結：${fullShareUrl}`, `Revoked external share link: ${fullShareUrl}`));
          await renderShareLinksTable();
          syncBannerWithSelectedTarget();
        });
        rowEl.querySelector("[data-restore]")?.addEventListener("click", async () => {
          await apiPost("/api/share/restore", { token: l.token });
          showToast(tr(`已恢復外部分享連結：${fullShareUrl}`, `Restored external share link: ${fullShareUrl}`));
          await renderShareLinksTable(fullShareUrl, tr("已恢復分享連結：", "Restored Shareable Link:"));
        });
        tbody.appendChild(rowEl);
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
            <span>${tr("快速分享 — 單一掃描檢視與留言", "Quick Share — Single-Scan View & Comment")}</span>
          </div>
          <div style="font-size:10.5px;color:var(--ui-text-muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${safeScanName}">
            ${safeScanName}
          </div>
        </div>
        <button type="button" class="btn-xs" id="btnCloseQuickSharePop" title="${tr("關閉", "Close")}" aria-label="Close Quick Share" style="height:22px;padding:0 5px;">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px;">
        <span class="gs-quick-share-chip" style="color:var(--ui-accent);border-color:var(--ui-accent);">${tr("僅限 3D 檢視 + 留言", "3D View + Comment Only")}</span>
        <span class="gs-quick-share-chip">${tr("鎖定單一掃描", "Single Scan Locked")}</span>
        <span class="gs-quick-share-chip">${tr("不開放測量", "No Measurements")}</span>
        <span class="gs-quick-share-chip">${tr("不開放下載", "No Download")}</span>
      </div>
      <div id="quickShareBodyArea" style="font-size:11.5px;color:var(--ui-text-secondary);padding:6px 0;">
        ${tr("正在準備分享連結...", "Preparing shareable link...")}
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
          <button type="button" class="btn-xs primary gs-share-copy-btn" id="btnCopyStudioQuickShareUrl" title="${tr("複製分享連結", "Copy Share Link")}">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            <span>${tr("複製", "Copy")}</span>
          </button>
          <button type="button" class="btn-xs gs-share-embed-btn" id="btnCopyStudioQuickEmbedCode" title="${tr("複製 Hostinger 網站嵌入 HTML 程式碼 (即時載入 3D)", "Copy Hostinger Website Builder HTML Embed Code (Instant 3D Load)")}">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
            </svg>
            <span>${tr("嵌入", "Embed")}</span>
          </button>
          <a href="${safeFullUrl}" target="_blank" rel="noopener noreferrer" class="btn-xs gs-share-open-btn" title="${tr("於新分頁開啟連結", "Open Link in New Tab")}">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </a>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;padding-top:6px;border-top:1px solid var(--ui-border);">
          <span style="font-size:10.5px;color:var(--ui-text-muted);">
            ${tr("瀏覽：", "Views: ")}<b style="color:var(--ui-text-primary);">${humanViews}</b>
            · ${tr("訪客：", "Visitors: ")}<b style="color:var(--ui-text-primary);">${uniqVisitors}</b>
            ${avgSec > 0 ? `· ${tr("平均：", "Avg: ")}<b style="color:var(--ui-accent);">${escapeHtml(formatDurationCompact(avgSec))}</b>` : ""}
          </span>
          <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;">
            <button type="button" class="btn-xs" id="btnQuickShareAnalytics" title="${tr("查看開啟此連結的訪客、停留時間與使用的 3D 工具", "View who opened this link, for how long & which 3D tools they used")}" style="font-size:10.5px;">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
              </svg>
              <span>${tr("統計", "Analytics")}</span>
            </button>
            ${
              canRevoke
                ? `<button type="button" class="btn-xs" id="btnRotateQuickShareUrl" title="${tr("撤銷目前連結並產生新連結", "Revoke current link and generate a new token")}" style="font-size:10.5px;">${tr("重設連結", "Reset Link")}</button>
                   <button type="button" class="btn-xs" id="btnRevokeQuickShareUrl" title="${tr("立即撤銷存取權限", "Revoke access immediately")}" style="font-size:10.5px;color:#ef4444;border-color:rgba(239,68,68,0.35);">${tr("撤銷", "Revoke")}</button>
                   <button type="button" class="btn-xs" id="btnOpenFullShareModalFromQuick" title="${tr("自訂權限 · 測量、下載或工區群組", "Custom permissions · Measurements, Download, Project Group")}" style="font-size:10.5px;">${tr("更多選項...", "More Options...")}</button>`
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

      const copyEmbedBtn = bodyArea.querySelector("#btnCopyStudioQuickEmbedCode");
      copyEmbedBtn?.addEventListener("click", async () => {
        const snippet = buildHostingerEmbedCode(linkObj.token, scan.name || scan.scan_id, { scanId: scan.scan_id });
        await copyTextToClipboard(snippet);
        flashCopyButtonState(copyEmbedBtn);
        showToast(tr("已複製 Hostinger 嵌入程式碼！請貼至網站 HTML 程式碼區塊。", "Copied Hostinger HTML Embed Code! Paste into an Embed Code block."));
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
    if (typeof applyScanLodMode === "function") {
      applyScanLodMode(STATE.scanLodMode || "auto", true);
    }
    applyRolePermissionsToUI();
    const roleInfo = getCurrentUserRoleInfo();
    if (roleInfo.canManageUsers) {
      await renderAdminControlPanel();
      await refreshSettingsServiceAccountUI();
      apiGet("/api/pix4d/settings")
        .then((res) => {
          if (res && res.settings) applyPix4dSettingsToUI(res.settings, true);
        })
        .catch(() => {});
    }
    const tbody = document.getElementById("offlineCacheTableBody");
    if (!tbody) return;
    tbody.innerHTML = "";
    STATE.scans.forEach((s) => {
      const isCached = STATE.cachedScanIds.has(s.scan_id);
      const rowEl = document.createElement("tr");
      rowEl.innerHTML = `
        <td><b style="color:var(--ui-text-primary);">${escapeHtml(s.name || s.scan_id || "")}</b></td>
        <td style="color:var(--ui-text-secondary);">${escapeHtml(s.project_group || "")}</td>
        <td><span class="gs-crs-pill">${escapeHtml(getScanCrsDisplayLabel(s))}</span></td>
        <td>${
          isCached
            ? `<span class="gs-crs-pill">${tr("已快取", "Cached")}</span>`
            : `<span style="color:var(--ui-text-muted);">${tr("未快取", "Uncached")}</span>`
        }</td>
        <td>
          <button type="button" class="btn-xs primary" data-cache-scan="${escapeHtml(s.scan_id || "")}" title="${isCached ? tr("更新瀏覽器快取", "Refresh Browser Cache") : tr("儲存至瀏覽器快取", "Cache in Browser")}">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
        </td>
      `;
      rowEl.querySelector("[data-cache-scan]")?.addEventListener("click", () => cacheScanInBrowser(s.scan_id));
      tbody.appendChild(rowEl);
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
      badge.textContent = tr("工作站未連線 · 隧道離線", "PC Unreachable · Tunnel Offline");
      badge.style.background = "rgba(239,68,68,0.16)";
      badge.style.color = "#ef4444";
      btnToggle.textContent = tr("啟動背景服務", "Start Daemon");
      if (detail) {
        detail.textContent = tr(
          "Windows 工作站反向隧道未連線。目前由 Google 雲端硬碟 .3tz 與瀏覽器快取提供掃描串流。",
          "Windows Workstation reverse tunnel is not connected. Serving scans from Google Drive .3tz Cloud & Browser Cache."
        );
      }
      return;
    }

    if (running) {
      badge.textContent = tr(`執行中 · PID ${st.pid || "Active"}`, `Running · PID ${st.pid || "Active"}`);
      badge.style.background = "rgba(16,185,129,0.16)";
      badge.style.color = "#10b981";
      btnToggle.textContent = tr("停止背景服務", "Stop Daemon");
      btnToggle.style.background = "rgba(239,68,68,0.14)";
      btnToggle.style.color = "#ef4444";
      btnToggle.style.borderColor = "rgba(239,68,68,0.35)";
      const pollNote = st.last_poll_at
        ? tr(
            `最後掃描收件匣：${new Date(st.last_poll_at * 1000).toLocaleTimeString()}`,
            `Last inbox poll: ${new Date(st.last_poll_at * 1000).toLocaleTimeString()}`
          )
        : tr("自動輪詢中", "Polling active");
      const jobNote = st.active_job
        ? tr(
            ` · 執行中：${st.active_job.name || st.active_job.scan_id} · ${Math.round(st.active_job.progress_pct || 0)}%`,
            ` · Active: ${st.active_job.name || st.active_job.scan_id} · ${Math.round(st.active_job.progress_pct || 0)}%`
          )
        : tr(
            ` · 佇列等待：${st.queued_count || 0} 組 · 掃描總數：${st.total_scans || STATE.scans.length}`,
            ` · Queue: ${st.queued_count || 0} waiting · Total scans: ${st.total_scans || STATE.scans.length}`
          );
      if (detail) {
        detail.textContent = `${pollNote}${jobNote}`;
      }
    } else {
      badge.textContent = tr("已停止 · 待命", "Stopped · Standby");
      badge.style.background = "rgba(245,158,11,0.16)";
      badge.style.color = "#f59e0b";
      btnToggle.textContent = tr("啟動背景服務", "Start Daemon");
      btnToggle.style.background = "";
      btnToggle.style.color = "";
      btnToggle.style.borderColor = "";
      if (detail) {
        detail.textContent = tr(
          "PC 背景 Google 雲端硬碟收件匣輪詢與 PIX4Dmatic 排程已暫停。點擊「啟動背景服務」即可恢復。",
          "Background Google Drive Inbox polling & PIX4Dmatic queue are paused on PC. Click 'Start Daemon' to resume."
        );
      }
    }
  }

  document.getElementById("btnAdminTogglePcDaemon")?.addEventListener("click", async () => {
    const btnToggle = document.getElementById("btnAdminTogglePcDaemon");
    const txtLower = String(btnToggle?.textContent || "").toLowerCase();
    const wantStart = txtLower.includes("start") || txtLower.includes("啟動");
    if (btnToggle) btnToggle.disabled = true;
    try {
      const res = await apiPost("/api/admin/pc-daemon", {
        actor_email: STATE.currentUser?.email || "",
        action: wantStart ? "start" : "stop",
      });
      await refreshAdminPcDaemonUI(res);
      showToast(
        res.message ||
          (res.daemon_running
            ? tr("已啟動工作站背景服務", "Workstation Daemon Started")
            : tr("已停止工作站背景服務", "Workstation Daemon Stopped"))
      );
      if (res.daemon_running) {
        await refreshScansCatalog(false);
      }
    } catch (err) {
      showToast(tr(`背景服務控制錯誤：${err.message}`, `Daemon Control Error: ${err.message}`));
      await refreshAdminPcDaemonUI();
    } finally {
      if (btnToggle) btnToggle.disabled = false;
    }
  });

  document.getElementById("btnAdminSyncPcInboxNow")?.addEventListener("click", async () => {
    const btnSync = document.getElementById("btnAdminSyncPcInboxNow");
    if (btnSync) {
      btnSync.disabled = true;
      btnSync.textContent = tr("同步中...", "Syncing...");
    }
    try {
      const res = await apiPost("/api/admin/pc-daemon", {
        actor_email: STATE.currentUser?.email || "",
        action: "sync_now",
      });
      await refreshAdminPcDaemonUI(res);
      await refreshScansCatalog(false);
      showToast(res.message || tr("已同步 Google 雲端硬碟收件匣與 .3tz 套件！", "Synced Google Drive Inbox & .3tz packages!"));
    } catch (err) {
      showToast(tr(`收件匣同步錯誤：${err.message}`, `Inbox Sync Error: ${err.message}`));
    } finally {
      if (btnSync) {
        btnSync.disabled = false;
        btnSync.textContent = tr("立即同步收件匣", "Sync Inbox Now");
      }
    }
  });

  document.getElementById("btnJumpQueueToSettings")?.addEventListener("click", () => {
    closeModal("modalQueue");
    openOfflineCacheModal();
  });

  // Admin Control Panel (5-Level Permissions & User Management)
  async function renderAdminControlPanel() {
    const myInfo = getCurrentUserRoleInfo();
    const canManageUsers = Boolean(myInfo.canManageUsers || myInfo.can_manage_users);
    if (!canManageUsers) return;
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

    if (rolePill) {
      rolePill.textContent = `${tr("目前權限", "Active Role")}: L${myInfo.level} — ${getLocalizedRoleLabel(myInfo.role)}`;
    }
    if (saveBtn) saveBtn.disabled = !canManageUsers;
    if (nameIn) nameIn.disabled = !canManageUsers;
    if (zhNameIn) zhNameIn.disabled = !canManageUsers;
    if (emailIn) emailIn.disabled = !canManageUsers;
    if (roleSel) roleSel.disabled = !canManageUsers;

    const gchatInp = document.getElementById("inputGChatWebhookUrl");
    const gchatSaveBtn = document.getElementById("btnSaveGChatWebhook");
    const gchatTestBtn = document.getElementById("btnSendTestGChat");
    if (gchatInp) gchatInp.disabled = !canManageUsers;
    if (gchatSaveBtn) gchatSaveBtn.disabled = !canManageUsers;
    if (gchatTestBtn) gchatTestBtn.disabled = !canManageUsers;
    if (gchatInp && (canManageUsers || myInfo.canRunWorkflows)) {
      apiGet("/api/queue/status")
        .then((qRes) => {
          if (qRes && qRes.gchat_webhook_url !== undefined) {
            gchatInp.value = qRes.gchat_webhook_url;
          }
        })
        .catch(() => {});
    }

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
    const isEn = window.getAppLanguage?.() === "en";
    users.forEach((u) => {
      const email = String(u.email || "").toLowerCase();
      const isOwner = OWNER_EMAILS_SET.has(email) || u.role === "owner";
      const uRole = isOwner ? "owner" : String(u.role || "viewer").toLowerCase();
      const uLevel = ROLE_LEVELS_MAP[uRole] || 2;
      const canEditRow =
        canManageUsers &&
        !isOwner &&
        (myInfo.role === "owner" || (myInfo.role === "admin" && uLevel < myInfo.level));

      const rowEl = document.createElement("tr");
      const roleOptionsHtml = ["owner", "admin", "editor", "viewer", "guest"]
        .map((rk) => {
          const disabledOpt =
            rk === "owner" || (myInfo.role === "admin" && (rk === "admin" || rk === "owner"));
          return `<option value="${rk}" ${uRole === rk ? "selected" : ""} ${
            disabledOpt && uRole !== rk ? "disabled" : ""
          }>L${ROLE_LEVELS_MAP[rk]} — ${getLocalizedRoleLabel(rk)}</option>`;
        })
        .join("");

      const rawDisplayName = isEn
        ? (u.name && u.name !== "雲在天" ? u.name : u.zh_name || u.name || "User")
        : (u.zh_name || u.name || "成員");
      const cleanDisplayName = String(rawDisplayName).replace(/\s*\([^)]*\)\s*/g, "").trim() || rawDisplayName;
      rowEl.innerHTML = `
        <td><b style="color:var(--ui-text-primary);">${escapeHtml(cleanDisplayName)}</b></td>
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
                }">L${uLevel} — ${escapeHtml(getLocalizedRoleLabel(uRole))}</span>`
          }
        </td>
        <td style="font-size:11px;color:var(--ui-text-secondary);">
          ${
            uRole === "owner"
              ? tr("完整系統權限 + 系統擁有者", "All permissions + System Owner")
              : uRole === "admin"
              ? tr("管理編輯者／檢視者／訪客成員 + 編輯工具", "Manage Editor/Viewer/Guest users + Editor tools")
              : uRole === "editor"
              ? tr("修改工區／掃描名稱、執行 PIX4Dmatic 與最佳化", "Rename sites/scans, run PIX4Dmatic & Optimizer")
              : uRole === "viewer"
              ? tr("檢視所有掃描 + 工程測量工具 · 不執行 PC 排程", "View all scans + Measurement/Surveying tools · No PC jobs")
              : tr("瀏覽與檢視掃描 + 距離／面積／座標測量", "Browse & inspect scans + Distance/Area/Coordinates")
          }
        </td>
        <td>
          ${
            canEditRow
              ? `<button type="button" class="btn-xs" data-admin-delete-user="${escapeHtml(
                  u.email
                )}" style="color:#ef4444;border-color:rgba(239,68,68,0.35);" title="${tr("移除成員", "Remove user")}">${tr("移除", "Remove")}</button>`
              : `<span style="font-size:10.5px;color:var(--ui-text-muted);">${
                  isOwner ? tr("受保護擁有者", "Protected Owner") : tr("唯讀", "Read-only")
                }</span>`
          }
        </td>
      `;

      const sel = rowEl.querySelector("[data-admin-role-select]");
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
            showToast(tr(`已將 ${cleanDisplayName} 更新為 ${getLocalizedRoleLabel(newRole)}`, `Updated ${cleanDisplayName} to ${getLocalizedRoleLabel(newRole)}`));
            await loadTeamUserProfiles();
            await renderAdminControlPanel();
            renderTeamProfilesGrid();
          } catch (err) {
            showToast(tr(`權限更新錯誤：${err.message}`, `Role Update Error: ${err.message}`));
            await renderAdminControlPanel();
          }
        });
      }

      const delBtn = rowEl.querySelector("[data-admin-delete-user]");
      if (delBtn) {
        delBtn.addEventListener("click", async () => {
          try {
            await apiPost("/api/admin/users/delete", {
              actor_email: STATE.currentUser?.email || "",
              email: u.email,
            });
            showToast(tr(`已移除成員 ${u.email}`, `Removed user ${u.email}`));
            await loadTeamUserProfiles();
            await renderAdminControlPanel();
            renderTeamProfilesGrid();
          } catch (err) {
            showToast(tr(`移除成員錯誤：${err.message}`, `Delete User Error: ${err.message}`));
          }
        });
      }

      tbody.appendChild(rowEl);
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
          pill.textContent = tr("已連線並驗證", "Connected & Verified");
          pill.style.background = "rgba(16,185,129,0.16)";
          pill.style.color = "#10b981";
        } else {
          pill.textContent = tr("需設定金鑰 .json", "Key Needed · .json");
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

  function updatePcStatusUI() {
    const chip = document.getElementById("pcStatusChip");
    const txt = document.getElementById("pcStatusText");
    if (!chip || !txt) return;
    if (STATE.pcOnline) {
      chip.classList.remove("state-offline");
      txt.textContent = tr("佇列", "Queue");
    } else {
      chip.classList.add("state-offline");
      txt.textContent = tr("離線", "Offline");
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
      if (lblUser) lblUser.textContent = tr("登入", "Sign In");
      if (avatarImg) avatarImg.style.display = "none";
      if (svgIcon) svgIcon.style.display = "inline-block";
      if (closeBtn) closeBtn.style.display = "none";
      if (confirmBtn) confirmBtn.style.display = "none";
      if (btnLogout) btnLogout.style.display = "none";
      if (gateStatus) {
        gateStatus.textContent = tr(
          "需要身分授權 — 請使用 Google 登入或以訪客模式進入",
          "Authorization required — Sign in with Google or use Guest Mode"
        );
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
    const targetEmail = String(STATE.currentUser.email || "").trim().toLowerCase();
    const isGuestEmail = !targetEmail || targetEmail === "guest" || targetEmail.startsWith("guest@");
    if (!isGuestEmail) {
      if (markAuthorized && window.__gsUserManuallyToggledLang) {
        const manualLang = typeof window.getAppLanguage === "function" ? window.getAppLanguage() : "zh-TW";
        STATE.currentUser.language = manualLang;
        if (typeof window.persistLanguageToServer === "function") {
          window.persistLanguageToServer(manualLang);
        }
      } else if (!window.__gsUserManuallyToggledLang) {
        if (
          (normalized.language === "zh-TW" || normalized.language === "en") &&
          !STATE._prefsFetchedForEmail &&
          typeof window.setAppLanguage === "function" &&
          normalized.language !== window.getAppLanguage?.()
        ) {
          window.setAppLanguage(normalized.language, { saveToServer: false });
        }
        if (STATE._prefsFetchedForEmail !== targetEmail || markAuthorized) {
          STATE._prefsFetchedForEmail = targetEmail;
          fetch(`/api/user/preferences?email=${encodeURIComponent(targetEmail)}`, {
            credentials: "same-origin",
            headers: typeof apiHeaders === "function" ? apiHeaders(false) : {},
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((prefData) => {
              const srvLang = prefData?.preferences?.language || prefData?.language;
              if (
                (srvLang === "zh-TW" || srvLang === "en") &&
                !window.__gsUserManuallyToggledLang &&
                typeof window.setAppLanguage === "function"
              ) {
                if (STATE.currentUser) STATE.currentUser.language = srvLang;
                try {
                  localStorage.setItem("gs_ui_language", srvLang);
                  localStorage.setItem("gathering_user_profile", JSON.stringify(STATE.currentUser));
                  localStorage.setItem("gs_current_user", JSON.stringify(STATE.currentUser));
                } catch (_) {}
                if (srvLang !== window.getAppLanguage?.()) {
                  window.setAppLanguage(srvLang, { saveToServer: false });
                }
              }
            })
            .catch(() => {});
        }
      }
    }
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
    const roleShortMap = {
      owner: tr("最高管理員", "Owner"),
      admin: tr("管理員", "Admin"),
      editor: tr("編輯者", "Editor"),
      viewer: tr("檢視者", "Viewer"),
      guest: tr("訪客", "Guest"),
    };
    const localRoleLabel = roleShortMap[rInfo.role] || rInfo.label;
    const isEn = window.getAppLanguage?.() === "en";
    const rawUserName = isEn
      ? STATE.currentUser.name || STATE.currentUser.zh_name || STATE.currentUser.email || "Guest"
      : STATE.currentUser.zh_name || STATE.currentUser.name || STATE.currentUser.email || "訪客";
    const cleanUserName = String(rawUserName).replace(/\s*\([^)]*\)\s*/g, "").trim() || rawUserName;
    if (lblUser) {
      lblUser.textContent = `${cleanUserName} · ${localRoleLabel}`;
    }
    const btnUser = document.getElementById("btnGoogleUser") || document.getElementById("btnCurrentUserProfile");
    if (btnUser) {
      btnUser.title = `${cleanUserName} · ${STATE.currentUser.email || ""} · L${rInfo.level} ${localRoleLabel}`;
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
      offlineLbl.textContent = tr(
        `啟用瀏覽器離線快取 · ${STATE.currentUser.email || "guest"}`,
        `Enable Offline Caching in Browser · ${STATE.currentUser.email || "guest"}`
      );
    }
    const engInput = document.getElementById("cntEngineerName");
    if (engInput && cleanUserName) {
      engInput.value = cleanUserName;
    }
    if (gateStatus) {
      gateStatus.textContent = tr(
        `目前登入：${cleanUserName} · ${STATE.currentUser.email || ""} · L${rInfo.level} ${localRoleLabel}`,
        `Signed in as: ${cleanUserName} · ${STATE.currentUser.email || ""} · L${rInfo.level} ${localRoleLabel}`
      );
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
            name: "雲在天",
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
      countBadge.textContent = tr(`${list.length} 位成員`, `${list.length} Member${list.length === 1 ? "" : "s"}`);
    }

    grid.innerHTML = "";
    const isEn = window.getAppLanguage?.() === "en";
    list.forEach((u) => {
      const isCurrent =
        STATE.isAuthorized &&
        STATE.currentUser &&
        String(STATE.currentUser.email || "").toLowerCase() === String(u.email || "").toLowerCase();
      const rawName = isEn
        ? (u.name && u.name !== "雲在天" ? u.name : u.zh_name || u.name || u.email || "Team Member")
        : (u.zh_name || u.name || u.email || "團隊成員");
      const cleanName = String(rawName).replace(/\s*\([^)]*\)\s*/g, "").trim() || rawName;
      const initials = (cleanName || u.email || "U")
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
      const safeName = escapeHtml(cleanName);
      const safeEmail = escapeHtml(u.email || "");
      const uRoleKey = String(u.role || "viewer").toLowerCase();
      const safeRoleLbl = escapeHtml(getLocalizedRoleLabel(uRoleKey));
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
        showToast(tr(`請使用 Google 帳號 ${u.email} 登入以驗證身分`, `Please sign in with Google · ${u.email} to verify this account`));
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
      if (typeof suspendCompare3DResources === "function" && typeof isMobileOrTabletDevice === "function" && isMobileOrTabletDevice()) {
        suspendCompare3DResources();
      }
      if (typeof suspendStudio3DResources === "function" && typeof isIOSOrIPadDevice === "function" && isIOSOrIPadDevice()) {
        suspendStudio3DResources();
      }
      const isMobile = typeof window !== "undefined" && window.innerWidth <= 767;
      if (!isMobile || STATE.siteTimelineOpen) {
        document.getElementById("siteTimelineSplitView")?.classList.add("active");
        if (STATE.siteTimelineOpen) {
          document.getElementById("viewMap")?.classList.add("mobile-site-open");
        }
      } else {
        document.getElementById("viewMap")?.classList.remove("mobile-site-open");
        document.getElementById("siteTimelineSplitView")?.classList.remove("active");
      }
      if (typeof updateNorthArrowCompass === "function") updateNorthArrowCompass(null);
      setTimeout(() => {
        if (gsMap && gsMap.drawMap) gsMap.drawMap();
        syncPreviewRendererContainer();
        if (
          (!isMobile || STATE.siteTimelineOpen) &&
          (STATE.selectedTimelineScanId || STATE.activeScanId) &&
          typeof loadScanIntoPreview === "function"
        ) {
          loadScanIntoPreview(STATE.selectedTimelineScanId || STATE.activeScanId);
        }
      }, 60);
    } else if (viewName === "studio") {
      if (typeof suspendPreview3DResources === "function") {
        suspendPreview3DResources();
      }
      if (typeof suspendCompare3DResources === "function" && typeof isMobileOrTabletDevice === "function" && isMobileOrTabletDevice()) {
        suspendCompare3DResources();
      }
      initStudio3D();
      handleResize();
      loadScanIntoStudio(optionalScanId || STATE.activeScanId);
    } else if (viewName === "compare") {
      if (typeof suspendPreview3DResources === "function") {
        suspendPreview3DResources();
      }
      if (typeof suspendStudio3DResources === "function" && typeof isMobileOrTabletDevice === "function" && isMobileOrTabletDevice()) {
        suspendStudio3DResources();
      }
      populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);
      initCompareView();
      handleResize();
      syncCompareScansFromDropdowns();
    }
  }

  document.querySelectorAll("#mainModeSwitcher .btn-seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (
        btn.dataset.view === "map" &&
        typeof window !== "undefined" &&
        window.innerWidth <= 768 &&
        STATE.activeView === "map" &&
        STATE.siteTimelineOpen &&
        typeof closeSiteTimeline === "function"
      ) {
        closeSiteTimeline();
        return;
      }
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
      const cnt = Math.max(2, Math.min(4, Number(STATE.compareScanCount) || 2));
      const isSplit = STATE.compareMode === "split";
      const isMobile = window.innerWidth <= 768;
      let w = stageW;
      let h = stageH;
      if (isSplit) {
        if (cnt === 4) {
          w = Math.max(1, Math.floor(stageW / 2));
          h = Math.max(1, Math.floor(stageH / 2));
        } else if (cnt === 3) {
          if (isMobile) {
            w = stageW;
            h = Math.max(1, Math.floor(stageH / 3));
          } else {
            w = Math.max(1, Math.floor(stageW / 3));
            h = stageH;
          }
        } else {
          w = Math.max(1, Math.floor(stageW / 2));
          h = stageH;
        }
      }
      [compareCtx.left, compareCtx.right, compareCtx.third, compareCtx.fourth].forEach((side) => {
        if (!side) return;
        const cw = Math.max(1, Number(side.container?.clientWidth) || w);
        const ch = Math.max(1, Number(side.container?.clientHeight) || h);
        side.camera.aspect = cw / ch;
        side.camera.updateProjectionMatrix();
        side.renderer.setSize(cw, ch);
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
      const settingsEmail = String(data.user_settings?.email || "").trim().toLowerCase();
      const curUserEmail = String(STATE.currentUser?.email || "").trim().toLowerCase();
      const isSignedInSettingsMatch = Boolean(
        settingsEmail &&
          settingsEmail !== "guest" &&
          !settingsEmail.startsWith("guest@") &&
          curUserEmail &&
          settingsEmail === curUserEmail
      );
      if (
        !STATE.isEmbedded &&
        isSignedInSettingsMatch &&
        data.user_settings &&
        data.user_settings.theme_preference &&
        !localStorage.getItem("gs_theme_pref")
      ) {
        await applyTheme(data.user_settings.theme_preference, false);
      }
      if (
        isSignedInSettingsMatch &&
        data.user_settings &&
        (data.user_settings.language === "zh-TW" || data.user_settings.language === "en") &&
        !window.__gsUserManuallyToggledLang &&
        typeof window.setAppLanguage === "function"
      ) {
        if (STATE.currentUser) STATE.currentUser.language = data.user_settings.language;
        if (data.user_settings.language !== window.getAppLanguage?.()) {
          window.setAppLanguage(data.user_settings.language, { saveToServer: false });
        }
      }

      if (data.mode === "external_share" && data.share_link) {
        STATE.shareLinkInfo = data.share_link;
        if (data.share_link.token && data.share_link.token !== STATE.shareToken) {
          STATE.shareToken = String(data.share_link.token);
        }
        const banner = document.getElementById("externalShareBanner");
        const scopeLbl = document.getElementById("lblExternalShareScope");
        if (banner && scopeLbl) {
          banner.style.display = "flex";
          const friendlyScope = resolveShareScopeTitle(data.share_link.scope_type, data.share_link.target_id);
          const linkPerms = [
            tr("3D 檢視", "3D View"),
            data.share_link.allow_measurements ? tr("工程測量", "Measurements") : null,
            data.share_link.allow_comments ? tr("3D 空間留言", "3D Comments") : null,
            data.share_link.allow_download ? tr("下載", "Download") : null,
          ]
            .filter(Boolean)
            .join(" + ");
          scopeLbl.textContent = `${data.share_link.label} · ${String(data.share_link.scope_type || "scan").toUpperCase()}: ${friendlyScope} — ${linkPerms}`;
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
        // Never silently switch the active Studio scan during a background poll if the user is actively in Studio
        if (STATE.scans.length > 0 && !(isBackgroundPoll && STATE.activeView === "studio" && STATE.activeScanId)) {
          const sameProjReady =
            STATE.activeProjectGroup && STATE.activeProjectGroup !== "__all__"
              ? STATE.scans.find((s) => s.project_group === STATE.activeProjectGroup && s.status === "completed")
              : null;
          const firstReady = sameProjReady || STATE.scans.find((s) => s.status === "completed") || STATE.scans[0];
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
      if (
        !isBackgroundPoll &&
        (urlScan ||
          (STATE.shareToken && String(STATE.shareLinkInfo?.scope_type || "").toLowerCase() === "scan"))
      ) {
        STATE.activeView = "studio";
      }
      populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);
      renderMapClusters({ preservePopover: Boolean(isBackgroundPoll) });

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

  window.onAppLanguageChanged = function (lang) {
    try {
      const topBadge = document.getElementById("topCrsBadge");
      if (topBadge) {
        topBadge.textContent = tr(
          "由 雲在天 博士與 Gemini 4 Argon 開發",
          "Created by Glib Ivanov, PhD and Gemini 4 Argon"
        );
        topBadge.title = tr(
          "由 雲在天 博士與 Gemini 4 Argon 共同開發",
          "Created by Glib Ivanov, PhD and Gemini 4 Argon"
        );
      }
      updatePcStatusUI();
      applyUserProfileToUI(STATE.currentUser, false);
      renderTeamProfilesGrid();
      applyTheme(STATE.themePreference, false);
      populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);
      renderMapClusters();
      if (STATE.siteTimelineOpen && STATE.activeView === "map") {
        openSiteTimeline(STATE.activeProjectGroup || "__all__", STATE.selectedTimelineScanId, false);
      }
      if (document.getElementById("modalQueue")?.classList.contains("active")) {
        refreshQueueModalData();
      }
      if (document.getElementById("modalSharing")?.classList.contains("active")) {
        renderShareLinksTable();
        if (_activeAnalyticsToken) openShareAnalyticsDrawer(_activeAnalyticsToken);
      }
      if (document.getElementById("modalOfflineCache")?.classList.contains("active")) {
        openOfflineCacheModal();
      }
      if (document.getElementById("recycleBinModal")?.classList.contains("active")) {
        renderRecycleBinItems(_cachedBinScans || []);
      }
      if (document.getElementById("deleteScanModal")?.classList.contains("active") && _deletingScanId) {
        openDeleteScanModal(_deletingScanId);
      }
      if (document.getElementById("renameScanModal")?.classList.contains("active") && _renamingScanId) {
        openRenameScanModal(_renamingScanId);
      }
      if (document.getElementById("renameSiteModal")?.classList.contains("active") && _renamingSiteGroup) {
        openRenameSiteModal(_renamingSiteGroup);
      }
      if (document.getElementById("rerunScanModal")?.classList.contains("active") && _rerunTargetScanId) {
        openRerunScanModal(_rerunTargetScanId);
      }
      const dlPopover = document.getElementById("gsDownloadFormatPopover");
      if (dlPopover && _downloadFormatMenuAnchor && _downloadFormatMenuScan) {
        openDownloadFormatMenu(_downloadFormatMenuAnchor, _downloadFormatMenuScan, true);
      }
      if (STATE.activeView === "compare") {
        setCompareMode(STATE.compareMode || "slider");
      }
      if (typeof syncCategorizeVisibilityUI === "function") syncCategorizeVisibilityUI();
      if (typeof syncFirstPersonHudUI === "function") syncFirstPersonHudUI();
      if (typeof syncStudioMobileToolHud === "function") syncStudioMobileToolHud();
      if (typeof syncMultiAlignToolAvailability === "function") syncMultiAlignToolAvailability();
      const lblCol = document.getElementById("lblCollapseSidePanel");
      if (lblCol) {
        const isMin = Boolean(STATE.sidePanelMinimized);
        lblCol.textContent = tr(isMin ? "▴ 展開" : "▾ 收合", isMin ? "▴ Expand" : "▾ Collapse");
      }
      if (STATE.activeView === "studio") {
        if (STATE.activeScan) {
          updateStudioScanMetricsReadout(STATE.activeScan);
          const pickedEl = document.getElementById("lblLastPickedCoord");
          if (pickedEl && inferActiveScanCrsCode(STATE.activeScan) === "LOCAL_ORIGIN") {
            pickedEl.textContent = tr("局部原點 · 點擊 3D 表面以檢視座標", "Local Origin · Click 3D surface to inspect");
          }
        }
        const panelEl = document.getElementById("studioSidePanel");
        const isOpen =
          panelEl &&
          !panelEl.classList.contains("hidden") &&
          window.getComputedStyle(panelEl).display !== "none";
        if (isOpen) {
          if (STATE.activeTool === "volume") openCutFillVolumeInspector(STATE.lastVolumeResult);
          else if (STATE.activeTool === "contours") openContoursInspector(true);
          else if (STATE.activeTool === "profile") openProfileInspector();
          else if (STATE.activeTool === "section") openSectionBoxInspector();
          else if (STATE.activeTool === "photos") openRtkPhotoInspector();
          else if (STATE.activeTool === "categorize") {
            if (STATE.lastCategorizeResult && STATE.lastCategorizeResult.scan_id === STATE.activeScanId) {
              openCategorizeInspector();
            } else {
              openCategorizeInspector();
            }
          } else if (STATE.activeTool === "comments") openCommentsInspector();
          else if (STATE.activeTool === "crop_delete") openLassoDeleteInspector({ armLasso: true });
          else if (STATE.activeTool === "crop") openLassoKeepInspector({ armLasso: true });
          else if (STATE.activeTool === "optimizer") openMeshCompressionInspector();
          else if (STATE.activeTool === "crs") openCoordinateSystemInspector();
          else if (STATE.activeTool === "generate_scan") openGenerateScanInspector();
          else if (STATE.activeTool === "align_merge" || STATE.multiAlign?.active) renderAlignMergeInspectorContent();
        }
      }
    } catch (err) {
      console.warn("[GatheringScans] onAppLanguageChanged refresh warning:", err);
    }
  };

  function syncEmbedHudUI() {
    if (!STATE.isEmbedded) return;
    document.documentElement.classList.add("gs-embed-mode");
    document.body.classList.add("gs-embed-mode");
    document.documentElement.setAttribute("data-theme", "light");
    document.body.classList.add("theme-light");
    document.body.classList.remove("theme-dark");
    const hud = document.getElementById("gsEmbedFloatingHud");
    if (hud) hud.style.display = "flex";
    const activeScan = STATE.activeScan || (STATE.scans || []).find((s) => s.scan_id === STATE.activeScanId) || (STATE.scans || [])[0] || null;
    const titleEl = document.getElementById("gsEmbedHudTitle");
    if (titleEl && activeScan) {
      titleEl.textContent = activeScan.name || activeScan.scan_id || "3D Scan";
    }
    const selEl = document.getElementById("gsEmbedScanSelect");
    if (selEl) {
      if ((STATE.scans || []).length > 1) {
        selEl.style.display = "";
        selEl.innerHTML = "";
        STATE.scans.forEach((s) => {
          const opt = document.createElement("option");
          opt.value = s.scan_id;
          opt.textContent = s.name || s.scan_id;
          selEl.appendChild(opt);
        });
        if (STATE.activeScanId) selEl.value = STATE.activeScanId;
      } else {
        selEl.style.display = "none";
      }
    }
    const curLod = STATE.scanLodMode === "rough" ? "rough" : "auto";
    document.querySelectorAll("#gsEmbedLodSwitcher [data-embed-lod]").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-embed-lod") === curLod);
    });
    const posterOverlay = document.getElementById("gsEmbedPosterOverlay");
    if (posterOverlay) {
      if (STATE.embedMode === "poster" && !STATE.embedPosterDismissed && activeScan) {
        posterOverlay.style.display = "flex";
        const posterImg = document.getElementById("gsEmbedPosterImg");
        if (posterImg && activeScan.thumbnail_url) posterImg.src = activeScan.thumbnail_url;
        const posterTitle = document.getElementById("gsEmbedPosterTitle");
        if (posterTitle) posterTitle.textContent = `${activeScan.name || activeScan.scan_id} · ${activeScan.project_group || "GatheringCloud"}`;
      } else {
        posterOverlay.style.display = "none";
      }
    }
  }
  window.syncEmbedHudUI = syncEmbedHudUI;

  function initEmbedHudControls() {
    document.getElementById("btnEmbedResetCamera")?.addEventListener("click", () => {
      if (typeof frameStudioCamera === "function") frameStudioCamera();
    });
    document.getElementById("btnEmbedFirstPerson")?.addEventListener("click", () => {
      if (typeof toggleFirstPersonMode === "function") toggleFirstPersonMode();
    });
    document.getElementById("btnEmbedFullscreen")?.addEventListener("click", () => {
      const rootEl = document.documentElement;
      if (!document.fullscreenElement && rootEl.requestFullscreen) {
        rootEl.requestFullscreen().catch(() => {});
      } else if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    });
    document.getElementById("gsEmbedScanSelect")?.addEventListener("change", (e) => {
      const nextSid = e.target.value;
      if (nextSid) {
        switchView("studio", nextSid);
        syncEmbedHudUI();
      }
    });
    document.querySelectorAll("#gsEmbedLodSwitcher [data-embed-lod]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-embed-lod") === "auto" ? "auto" : "rough";
        if (typeof applyScanLodMode === "function") applyScanLodMode(mode, false);
        syncEmbedHudUI();
      });
    });
    const dismissPosterAndStart = () => {
      if (STATE.embedPosterDismissed) return;
      STATE.embedPosterDismissed = true;
      const posterOverlay = document.getElementById("gsEmbedPosterOverlay");
      if (posterOverlay) posterOverlay.style.display = "none";
      if (STATE.activeScanId) {
        switchView("studio", STATE.activeScanId);
      }
    };
    document.getElementById("btnEmbedPosterStart")?.addEventListener("click", dismissPosterAndStart);
    document.getElementById("gsEmbedPosterOverlay")?.addEventListener("click", dismissPosterAndStart);
  }

  // Bootstrap Application, Theme Engine (Default: Time of Day Auto) & Mandatory Authorization Gate
  window.addEventListener("DOMContentLoaded", async () => {
    const topBadge = document.getElementById("topCrsBadge");
    if (topBadge) {
      topBadge.textContent = tr(
        "由 雲在天 博士與 Gemini 4 Argon 開發",
        "Created by Glib Ivanov, PhD and Gemini 4 Argon"
      );
      topBadge.title = tr(
        "由 雲在天 博士與 Gemini 4 Argon 共同開發",
        "Created by Glib Ivanov, PhD and Gemini 4 Argon"
      );
    }
    if (typeof window.applyStaticDomTranslations === "function") {
      window.applyStaticDomTranslations(document);
    }
    initEmbedHudControls();
    await applyTheme(STATE.themePreference, false);
    applyUserProfileToUI(STATE.currentUser, false);
    if (!STATE.isAuthorized && !STATE.shareToken && !STATE.isEmbedded) {
      document.body.classList.add("gs-auth-locked");
      openUserProfileGateModal();
    } else if (!STATE.isEmbedded) {
      loadTeamUserProfiles();
    }

    // Zero-Roundtrip Instant Bootstrap when server pre-injected window.__GS_EMBED_BOOTSTRAP__
    const bootPayload = window.__GS_EMBED_BOOTSTRAP__;
    if (bootPayload && Array.isArray(bootPayload.scans) && bootPayload.scans.length > 0) {
      if (bootPayload.share_token) {
        STATE.shareToken = String(bootPayload.share_token);
      }
      STATE.scans = bootPayload.scans;
      STATE.projects = bootPayload.projects || [];
      if (bootPayload.materials) STATE.materials = bootPayload.materials;
      if (bootPayload.share_link) STATE.shareLinkInfo = bootPayload.share_link;
      if (!STATE.activeScanId || !STATE.scans.some((s) => s.scan_id === STATE.activeScanId)) {
        STATE.activeScanId = bootPayload.initial_scan_id || STATE.scans[0].scan_id;
      }
      const leadScan = STATE.scans.find((s) => s.scan_id === STATE.activeScanId) || STATE.scans[0];
      STATE.activeScan = leadScan;
      if (leadScan && leadScan.project_group) STATE.activeProjectGroup = leadScan.project_group;
      applyRolePermissionsToUI();
      populateProjectScanDropdowns(STATE.activeProjectGroup, STATE.activeScanId);
      syncEmbedHudUI();
      if (STATE.isEmbedded) {
        if (STATE.embedMode === "poster" && !STATE.embedPosterDismissed) {
          // Pre-warm tileset.json in background while displaying high-res poster
          if (bootPayload.preload_stream_url) {
            fetch(bootPayload.preload_stream_url, { mode: "cors" }).catch(() => {});
          }
        } else {
          switchView("studio", STATE.activeScanId);
        }
      } else if (
        new URLSearchParams(window.location.search).get("scan") ||
        (STATE.shareToken && String(STATE.shareLinkInfo?.scope_type || "").toLowerCase() === "scan")
      ) {
        switchView("studio", STATE.activeScanId);
      }
      // Refresh catalog non-blockingly in the background
      setTimeout(() => refreshScansCatalog(true), 1200);
    } else {
      await refreshScansCatalog(false);
      syncEmbedHudUI();
      const urlScan = new URLSearchParams(window.location.search).get("scan");
      if (STATE.isEmbedded && STATE.activeScanId) {
        if (!(STATE.embedMode === "poster" && !STATE.embedPosterDismissed)) {
          switchView("studio", STATE.activeScanId);
        }
      } else if (urlScan) {
        switchView("studio", urlScan);
      } else if (
        STATE.shareToken &&
        String(STATE.shareLinkInfo?.scope_type || "").toLowerCase() === "scan" &&
        STATE.activeScanId
      ) {
        switchView("studio", STATE.activeScanId);
      }
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
          const activeSides = typeof getActiveCompareSides === "function" ? getActiveCompareSides() : [compareCtx.left, compareCtx.right].filter(Boolean);
          activeSides.forEach((side) => {
            if (side && side.tilesRenderer) {
              side.camera.updateMatrixWorld();
              side.tilesRenderer.update();
              needsRender = true;
            }
          });
          syncCompareLoaderProgress();
          if (needsRender) {
            activeSides.forEach((side) => {
              if (side && side.renderer) side.renderer.render(side.scene, side.camera);
            });
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
    triggerStudioEscapeAction: (...args) => window.triggerStudioEscapeAction?.(...args),
    getAllSnappableToolVertices,
    findNearestSnappableToolVertex,
    findNearestEditableVertexAtScreenXY,
    startStudioVertexMove,
    updateStudioVertexMove,
    commitStudioVertexMove,
    cancelStudioVertexMove,
    rebuildAllCompletedMeasurements3D,
    uploadLocalFilesToComment: (...args) => window.uploadLocalFilesToComment?.(...args),
  };

