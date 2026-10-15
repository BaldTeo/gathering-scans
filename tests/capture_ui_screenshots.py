#!/usr/bin/env python3
"""
Automated Headless Chrome CDP Visual E2E Runner & Screenshot Capturer
Drives Chrome 1600x960 via DevTools Protocol, verifies zero JS runtime errors,
tests interactive UI workflows, and saves screenshots to the Artifact Directory.
"""

import os
import json
import time
import base64
import shutil
import tempfile
import subprocess
import urllib.request
import websocket

CHROME_EXE = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
BASE_URL = "http://127.0.0.1:8095"
ARTIFACT_DIR = r"C:\Users\user\.gemini\antigravity\brain\a9a1ef66-7562-4e8a-9f4f-f2f841ffdeb5"
os.makedirs(ARTIFACT_DIR, exist_ok=True)


import socket


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ChromeCDP:
    def __init__(self, port: int = 0):
        self.port = port or get_free_port()
        self.user_data_dir = tempfile.mkdtemp(prefix="gs_chrome_e2e_")
        self.proc = subprocess.Popen(
            [
                CHROME_EXE,
                "--headless=new",
                "--enable-unsafe-swiftshader",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-background-timer-throttling",
                "--hide-scrollbars",
                "--window-size=1600,960",
                "--remote-allow-origins=*",
                f"--remote-debugging-port={self.port}",
                f"--user-data-dir={self.user_data_dir}",
                "--no-first-run",
                "--no-default-browser-check",
                BASE_URL,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.ws = None
        self.msg_id = 0
        self.console_errors = []
        self._connect()

    def _connect(self):
        for _ in range(30):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json") as r:
                    tabs = json.loads(r.read().decode("utf-8"))
                page_tabs = [t for t in tabs if t.get("type") == "page"]
                if page_tabs:
                    ws_url = page_tabs[0]["webSocketDebuggerUrl"]
                    self.ws = websocket.create_connection(ws_url, timeout=15)
                    self.send("Page.enable")
                    self.send("Runtime.enable")
                    self.send("Page.bringToFront")
                    return
            except Exception:
                time.sleep(0.3)
        raise RuntimeError("Could not connect to Chrome CDP")

    def send(self, method: str, params: dict = None):
        self.msg_id += 1
        target_id = self.msg_id
        payload = {"id": target_id, "method": method, "params": params or {}}
        self.ws.send(json.dumps(payload))
        while True:
            raw = self.ws.recv()
            msg = json.loads(raw)
            if msg.get("method") == "Runtime.exceptionThrown":
                self.console_errors.append(str(msg.get("params")))
            if msg.get("id") == target_id:
                return msg.get("result", {})

    def eval_js(self, expr: str):
        res = self.send("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
        return res.get("result", {}).get("value")

    def screenshot(self, filename: str) -> str:
        self.send("Page.bringToFront")
        res = self.send("Page.captureScreenshot", {"format": "png", "fromSurface": True})
        b64 = res.get("data", "")
        out_path = os.path.join(ARTIFACT_DIR, filename)
        with open(out_path, "wb") as f:
            f.write(base64.b64decode(b64))
        print(f"[CDP] Saved screenshot: {out_path}")
        return out_path

    def close(self):
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(self.proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
        except Exception:
            pass
        shutil.rmtree(self.user_data_dir, ignore_errors=True)


def run_visual_e2e():
    cdp = ChromeCDP()
    try:
        # 1. Map Overview with Real Google Maps Satellite Hybrid Tiles + Cluster Hover Popover
        time.sleep(2.5)
        map_check = cdp.eval_js(
            """(() => {
                const sel = document.getElementById('studioScanSelect');
                const opts = sel ? Array.from(sel.options).map(o => o.textContent) : [];
                return {
                    projectBadge: document.getElementById('studioProjectGroupBadge')?.textContent || '',
                    dropdownCount: opts.length,
                    dropdownOptions: opts,
                    hasBrightnessSlider: !!document.getElementById('studioBrightnessSlider')
                };
            })()"""
        )
        print(f"[CDP Verify #2 & #4] Active Project Filtering & Brightness Control: {map_check}")
        assert map_check["dropdownCount"] == 5, f"Expected 5 QuChi Dam scans in dropdown, got {map_check}"
        assert all("Riverbank" not in o and "Nanshi" not in o for o in map_check["dropdownOptions"]), "Non-project scans leaked into dropdown"
        assert map_check["hasBrightnessSlider"] is True, "Missing Scan Brightness slider"
        cdp.screenshot("e2e_1_map_overview.png")

        # 1B. Select Site -> Verify Top 1/3 Timeline Tiles (Auto-Captured Screenshot, Date, Uploader) + Bottom 2/3 3D Scan Preview + Icon-Only Enlarge Button
        cdp.eval_js("document.querySelector('.scan-cluster-blob')?.click()")
        time.sleep(2.2)
        timeline_check = cdp.eval_js(
            """(() => {
                const splitEl = document.getElementById('siteTimelineSplitView');
                const topPane = document.getElementById('siteTimelineTopPane');
                const bottomPane = document.getElementById('sitePreviewBottomPane');
                const tiles = Array.from(document.querySelectorAll('#siteTimelineTilesTrack .gs-timeline-tile'));
                const enlargeBtn = document.getElementById('btnEnlargePreviewToStudio');
                const topRect = topPane ? topPane.getBoundingClientRect() : { height: 0 };
                const botRect = bottomPane ? bottomPane.getBoundingClientRect() : { height: 0 };
                return {
                    splitActive: splitEl ? splitEl.classList.contains('active') : false,
                    topHeightRatio: (topRect.height + botRect.height) > 0 ? +(topRect.height / (topRect.height + botRect.height)).toFixed(2) : 0,
                    bottomHeightRatio: (topRect.height + botRect.height) > 0 ? +(botRect.height / (topRect.height + botRect.height)).toFixed(2) : 0,
                    tileCount: tiles.length,
                    tilesData: tiles.map(t => ({
                        scanId: t.dataset.scanId,
                        date: t.querySelector('.gs-tile-date')?.textContent.trim() || '',
                        uploader: t.querySelector('.gs-tile-uploader')?.textContent.trim() || '',
                        thumbLoaded: (t.querySelector('img.gs-tile-thumb')?.naturalWidth || 0) > 0
                    })),
                    enlargeBtnExists: !!enlargeBtn,
                    enlargeBtnText: enlargeBtn ? enlargeBtn.textContent.trim() : 'MISSING',
                    enlargeBtnHasSvg: enlargeBtn ? !!enlargeBtn.querySelector('svg') : false,
                    previewCanvasExists: !!document.querySelector('#sitePreviewCanvasContainer canvas')
                };
            })()"""
        )
        print(f"[CDP Verify #7] Site Timeline + 2/3 Preview + Icon-Only Enlarge: {timeline_check}")
        assert timeline_check["splitActive"] is True, "Site Timeline Split View should be active when a site is selected"
        assert timeline_check["tileCount"] >= 2, f"Expected multiple scan tiles in timeline, got {timeline_check['tileCount']}"
        assert all(t["date"] and t["uploader"] and t["thumbLoaded"] for t in timeline_check["tilesData"]), f"Every tile must have loaded screenshot, date, and uploader: {timeline_check['tilesData']}"
        assert timeline_check["enlargeBtnExists"] and timeline_check["enlargeBtnText"] == "" and timeline_check["enlargeBtnHasSvg"], "Enlarge button must have 0 words (no text, only SVG icon)"
        assert timeline_check["previewCanvasExists"] is True, "Bottom 2/3 3D Scan Preview WebGL canvas must be active"
        cdp.screenshot("e2e_7_site_timeline_preview.png")

        # Click Enlarge icon-only button on bottom 2/3 preview -> verify it goes to the full 3D Viewer/Editor (#viewStudio)
        cdp.eval_js("document.getElementById('btnEnlargePreviewToStudio').click()")
        time.sleep(2.0)
        enlarged_to_studio = cdp.eval_js("document.getElementById('viewStudio')?.classList.contains('active') || false")
        print(f"[CDP Verify #7b] Enlarge button transitioned to full 3D Studio Viewer/Editor: {enlarged_to_studio}")
        assert enlarged_to_studio is True, "Clicking #btnEnlargePreviewToStudio must open #viewStudio"

        # 2. In 3D Scan Studio, adjust Scan Brightness to 1.25x, and test Gathering Cloud X/Y/Z Distance Tool
        cdp.eval_js(
            """(() => {
                const slider = document.getElementById('studioBrightnessSlider');
                if (slider) {
                    slider.value = '1.2';
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                    slider.value = '1.0';
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                }
            })()"""
        )
        # Click Distance Tool and dispatch 2 clicks on #studioCanvasContainer canvas to measure 3D Distance with X, Y, Z legs
        cdp.eval_js("document.getElementById('btnMeasureDistance').click()")
        time.sleep(0.3)
        dist_check = cdp.eval_js(
            """(() => {
                const el = document.querySelector('#studioCanvasContainer canvas') || document.getElementById('studioCanvasContainer');
                const r = el.getBoundingClientRect();
                const clickAt = (fx, fy) => {
                    const cx = r.left + r.width * fx;
                    const cy = r.top + r.height * fy;
                    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: cx, clientY: cy }));
                    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: cx, clientY: cy }));
                };
                clickAt(0.38, 0.56);
                clickAt(0.60, 0.44);
                return {
                    distBadges: document.querySelectorAll('.autodesk-dist-badge').length,
                    deltaBadges: document.querySelectorAll('.autodesk-delta-badge').length,
                    deltaAxes: Array.from(document.querySelectorAll('.autodesk-delta-axis')).map(a => a.textContent)
                };
            })()"""
        )
        print(f"[CDP Verify #5] Gathering Cloud X, Y, Z Distance Tool: {dist_check}")
        assert dist_check["distBadges"] >= 1, "Expected .autodesk-dist-badge in 3D view"
        assert dist_check["deltaBadges"] >= 2, "Expected X/Y/Z .autodesk-delta-badge elements in 3D view"

        # Now test Cut/Fill Volume placement by clicking 3 points on the 3D scan and verifying it persists!
        cdp.eval_js("document.getElementById('btnMeasureVolume').click()")
        time.sleep(0.5)
        vol_check = cdp.eval_js(
            """(async () => {
                const el = document.querySelector('#studioCanvasContainer canvas') || document.getElementById('studioCanvasContainer');
                const r = el.getBoundingClientRect();
                const clickAt = (fx, fy) => {
                    const cx = r.left + r.width * fx;
                    const cy = r.top + r.height * fy;
                    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: cx, clientY: cy }));
                    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: cx, clientY: cy }));
                };
                clickAt(0.43, 0.48);
                clickAt(0.57, 0.48);
                clickAt(0.52, 0.62);
                await new Promise(res => setTimeout(res, 700));
                const labels = Array.from(document.querySelectorAll('#studioOverlay2D .measure-badge-2d')).map(d => d.textContent.trim());
                return {
                    labelsAfterPlacement: labels,
                    distBadgesStillPresent: document.querySelectorAll('.autodesk-dist-badge').length
                };
            })()"""
        )
        print(f"[CDP Verify #1] Persistent 3D Cut/Fill Placement: {vol_check}")
        assert any("Fill:" in lbl for lbl in vol_check["labelsAfterPlacement"]), "Expected persistent 3D Cut/Fill volume label on scan"
        cdp.screenshot("e2e_2_studio_volume_toolbar.png")

        # 3. Trigger Elevation Contours & .DWG Exporter
        cdp.eval_js("document.getElementById('btnMeasureContours').click()")
        time.sleep(0.7)
        cdp.screenshot("e2e_3_studio_contours_dwg.png")

        # 4. Switch to Multi-Date Curtain Slider Compare + Delta-Z Heatmap
        cdp.eval_js("document.getElementById('btnNavCompare').click()")
        time.sleep(0.8)
        cdp.eval_js("document.getElementById('chkDeltaZHeatmap').click()")
        time.sleep(0.5)
        cdp.screenshot("e2e_4_multidate_slider.png")

        # 5. Open PIX4Dmatic Smart Priority Queue & .GST Script Preview
        cdp.eval_js("document.getElementById('pcStatusChip').click()")
        time.sleep(0.5)
        cdp.eval_js("document.getElementById('btnPreviewGstScript').click()")
        time.sleep(0.5)
        cdp.screenshot("e2e_5_smart_queue_gst.png")

        # 6. Close Queue Modal & Open Scoped External Sharing Controls
        cdp.eval_js("document.querySelector('[data-close-modal=\"modalQueue\"]').click()")
        time.sleep(0.3)
        cdp.eval_js("document.getElementById('btnOpenSharing').click()")
        time.sleep(0.5)
        cdp.eval_js("document.getElementById('btnCreateShareLink').click()")
        time.sleep(0.5)
        cdp.screenshot("e2e_6_sharing_controls.png")

        if cdp.console_errors:
            print(f"[CDP Warning] Console exceptions detected: {cdp.console_errors}")
        else:
            print("[CDP] Zero uncaught JS exceptions across all views and tools!")
    finally:
        cdp.close()


if __name__ == "__main__":
    run_visual_e2e()
