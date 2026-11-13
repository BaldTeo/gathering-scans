/**
 * GatheringScans Frontend Module 01b — Studio HD tile budget & device profile.
 *
 * Browsers cap navigator.deviceMemory at 8 GB, so a 64 GB / 24 GB-VRAM workstation looked identical to a
 * mid-range laptop and got the same small HD tile budget. This module detects workstation-class desktops
 * (many cores + discrete high-end GPU / large JS heap) and gives them a much larger budget, while the
 * "learned crash shrink" now decays so one past WebGL context loss never permanently cripples quality.
 *
 * Overrides (DevTools console):
 *   localStorage.gs_hd_workstation = "1" | "0"   force workstation profile on/off
 *   localStorage.gs_hd_budget_mb   = "4096"      force the Auto-mode HD budget in MB (Fine uses 2.4x)
 *   localStorage.removeItem("gs_hd_budget_scale_v1")  reset the learned crash shrink
 */
"use strict";

const HD_SCALE_KEY = "gs_hd_budget_scale_v1";
const HD_SCALE_RECOVERY_HOURS = 6; // learned shrink fully recovers this long after the last context loss

function _readLearnedHdScaleRecord() {
  try {
    const raw = String(localStorage.getItem(HD_SCALE_KEY) || "");
    if (!raw) return { scale: 1, ts: 0 };
    const [s, t] = raw.split("|");
    return { scale: Math.max(0.3, Math.min(1, Number(s) || 1)), ts: Number(t) || 0 };
  } catch (_) {
    return { scale: 1, ts: 0 };
  }
}

function getLearnedHdScale() {
  const { scale, ts } = _readLearnedHdScaleRecord();
  if (scale >= 1) return 1;
  // Legacy records (no timestamp) and old shrinks recover fully; fresh ones recover linearly.
  const hours = ts > 0 ? (Date.now() - ts) / 3600000 : Infinity;
  const k = Math.max(0, Math.min(1, hours / HD_SCALE_RECOVERY_HOURS));
  return scale + (1 - scale) * k;
}

function shrinkHdBudgetAfterCrash() {
  try {
    const next = Math.max(isWorkstationClassDevice() ? 0.6 : 0.3, getLearnedHdScale() * 0.65);
    localStorage.setItem(HD_SCALE_KEY, `${next}|${Date.now()}`);
  } catch (_) {}
}

function isWorkstationClassDevice() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (window.__gsWsClass !== undefined) return window.__gsWsClass;
  let ok = false;
  try {
    const isIOS = typeof isIOSOrIPadDevice === "function" && isIOSOrIPadDevice();
    const isPhone = typeof isIPhoneOrMobilePhone === "function" && isIPhoneOrMobilePhone();
    const isMobOrTab = isIOS || isPhone || (typeof isMobileOrTabletDevice === "function" && isMobileOrTabletDevice());
    const forced = String(localStorage.getItem("gs_hd_workstation") || "");
    if (isMobOrTab) {
      ok = false;
    } else if (forced === "1" || forced === "0") {
      ok = forced === "1";
    } else {
      const cores = Number(navigator.hardwareConcurrency) || 4;
      const heap = Number(performance?.memory?.jsHeapSizeLimit) || 0;
      let gpu = "";
      try {
        const c = document.createElement("canvas");
        const gl = c.getContext("webgl");
        const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
        gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "") : "";
        const lose = gl && gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      } catch (_) {}
      const strongGpu = /RTX\s?(20|30|40|50)\d0|RTX\s?A\d|Quadro|RTX PRO|Titan|Radeon (RX (6[7-9]|7|9)|Pro W)|Apple M\d\s?(Pro|Max|Ultra)/i.test(gpu);
      ok = (cores >= 12 && (strongGpu || heap >= 3.5e9)) || (strongGpu && cores >= 8);
    }
  } catch (_) {}
  window.__gsWsClass = ok;
  return ok;
}
window.isWorkstationClassDevice = isWorkstationClassDevice;

function getStudioHdTileBudget(lodMode) {
  const isIOS = typeof isIOSOrIPadDevice === "function" && isIOSOrIPadDevice();
  const isPhone = typeof isIPhoneOrMobilePhone === "function" && isIPhoneOrMobilePhone();
  const isMobOrTab = isIOS || isPhone || (typeof isMobileOrTabletDevice === "function" && isMobileOrTabletDevice());
  const MB = 1024 * 1024;
  if (lodMode === "rough") return { maxHdBytes: 32 * MB, maxHdTiles: 8 };
  const max = lodMode === "max";
  const ws = isWorkstationClassDevice();
  const dm = Number((typeof navigator !== "undefined" && navigator.deviceMemory) || (isIOS ? 6 : 8));
  let mb;
  let tileMb = 5.0;
  if (isMobOrTab) {
    mb = dm >= 8 ? (max ? 896 : 640) : dm >= 6 ? (max ? 704 : 512) : dm >= 4 ? (max ? 512 : 384) : (max ? 320 : 256);
  } else if (ws) {
    let autoMb = 2560;
    try {
      const o = Number(localStorage.getItem("gs_hd_budget_mb"));
      if (o >= 256) autoMb = o;
    } catch (_) {}
    mb = max ? Math.round(autoMb * 2.4) : autoMb; // Fine is clearly larger than Auto (6 GB vs 2.5 GB by default)
    tileMb = 4.0;
  } else {
    mb = dm >= 8 ? (max ? 1536 : 640) : (max ? 1024 : 480);
  }
  mb = Math.round(mb * getLearnedHdScale());
  return { maxHdBytes: mb * MB, maxHdTiles: Math.max(12, Math.round(mb / tileMb)) };
}
window.getStudioHdTileBudget = getStudioHdTileBudget;
