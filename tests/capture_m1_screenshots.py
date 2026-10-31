#!/usr/bin/env python3
"""
Automated Headless Chrome CDP Screenshot Runner for Milestone 1:
Cut/Fill Volume Inspector with:
- Least-Squares best-fit plane
- BCM/LCM/CCM mass conservation schedule
- Conserved mass identity
- Dump truck haul load trip estimator
- Dual Dark & Light themes with ZERO emojis and strict 1-word buttons.
"""

import os
import sys
import time
import json
import base64
import asyncio
import subprocess
import urllib.request
import websockets

CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
SCREENSHOT_DIR = r"c:\Antigravity\GatheringScans\.agents\teamwork\screenshots"
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

OUT_PATH_DARK = os.path.join(SCREENSHOT_DIR, "m1_volume_mass_dark_theme.png")
OUT_PATH_LIGHT = os.path.join(SCREENSHOT_DIR, "m1_volume_mass_light_theme.png")
OUT_PATH_DARK_SCROLLED = os.path.join(SCREENSHOT_DIR, "m1_volume_mass_dark_scrolled.png")
OUT_PATH_LIGHT_SCROLLED = os.path.join(SCREENSHOT_DIR, "m1_volume_mass_light_scrolled.png")
OUT_PATH_PANEL_ZOOM_DARK = os.path.join(SCREENSHOT_DIR, "m1_volume_mass_panel_zoom_dark.png")
OUT_PATH_PANEL_ZOOM_LIGHT = os.path.join(SCREENSHOT_DIR, "m1_volume_mass_panel_zoom_light.png")


async def cdp_call(ws, method, params=None, msg_id=1):
    payload = {"id": msg_id, "method": method, "params": params or {}}
    await ws.send(json.dumps(payload))
    while True:
        resp = json.loads(await ws.recv())
        if resp.get("id") == msg_id:
            return resp.get("result", {})


async def capture_m1():
    port = 9226
    url = "http://127.0.0.1:8095/?scan=quchi_20261005_merged&tool=volume"
    cmd = [
        CHROME_PATH,
        "--headless=new",
        f"--remote-debugging-port={port}",
        "--window-size=1920,1080",
        "--disable-gpu=false",
        "--enable-webgl",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        url,
    ]
    print(f"Launching Chrome: {' '.join(cmd)}")
    proc = subprocess.Popen(cmd)

    try:
        ws_url = None
        for _ in range(30):
            time.sleep(0.5)
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2) as resp:
                    tabs = json.loads(resp.read().decode("utf-8"))
                    for t in tabs:
                        if t.get("type") == "page":
                            ws_url = t.get("webSocketDebuggerUrl")
                            break
                    if ws_url:
                        break
            except Exception:
                pass

        if not ws_url:
            raise RuntimeError("Could not obtain Chrome WebSocket Debugger URL.")

        print(f"Connected to CDP WebSocket: {ws_url}")
        async with websockets.connect(ws_url, max_size=50 * 1024 * 1024) as ws:
            await cdp_call(ws, "Page.enable", msg_id=10)
            await cdp_call(ws, "Runtime.enable", msg_id=11)

            print("Waiting for page load & dismissing auth modal...")
            await asyncio.sleep(4.0)

            # Dismiss auth gate modal
            dismiss_script = """
            (() => {
                const btnGuest = document.getElementById("btnGateGuestEnter");
                if (btnGuest) {
                    btnGuest.click();
                }
                const modal = document.getElementById("userProfileGateModal");
                if (modal) {
                    modal.style.display = 'none';
                }
                if (typeof showView === 'function') {
                    showView('studio');
                }
                return 'auth_handled';
            })()
            """
            res_dismiss = await cdp_call(ws, "Runtime.evaluate", {"expression": dismiss_script}, msg_id=15)
            print("Auth modal dismiss result:", res_dismiss)

            print("Waiting for 3D Studio scene to load...")
            await asyncio.sleep(4.0)

            # Trigger Cut/Fill volume with Best-Fit Plane and 4 boundary points
            init_vol_script = """
            (() => {
                // Ensure studio side panel is open
                const panel = document.getElementById("studioSidePanel");
                if (panel) {
                    panel.classList.add("active");
                    panel.classList.remove("hidden", "mobile-minimized", "gs-panel-minimized");
                }
                
                // Select Best-Fit Plane
                const modeSel = document.getElementById("volBaseMode");
                if (modeSel) {
                    modeSel.value = "best_fit_plane";
                    modeSel.dispatchEvent(new Event("change", { bubbles: true }));
                }

                // Call openCutFillVolumeInspector with boundary points
                if (typeof window.openCutFillVolumeInspector === 'function') {
                    const pts = [
                        new THREE.Vector3(-8.0, 2.093, 7.0),
                        new THREE.Vector3(8.0, -8.798, 7.0),
                        new THREE.Vector3(8.0, 2.141, -7.0),
                        new THREE.Vector3(-8.0, 1.849, -7.0)
                    ];
                    window.openCutFillVolumeInspector(pts);
                    return 'inspector_opened_with_pts';
                }
                return 'function_not_found';
            })()
            """
            res_init = await cdp_call(ws, "Runtime.evaluate", {"expression": init_vol_script}, msg_id=20)
            print("Init volume script result:", res_init)

            # Wait for calculation and 3D rendering
            print("Waiting for volume calculation & 3D mesh rendering...")
            await asyncio.sleep(5.0)

            # Check that results and Best-Fit plane schedule are in DOM
            check_dom_script = """
            (() => {
                const resBox = document.getElementById("volResultContainer");
                const html = resBox ? resBox.innerHTML : "";
                const panel = document.getElementById("studioSidePanel");
                if (panel) {
                    panel.classList.add("active");
                    panel.classList.remove("hidden", "mobile-minimized", "gs-panel-minimized");
                }
                return {
                    hasHtml: Boolean(html),
                    hasBcm: html.includes("BCM"),
                    hasBestFit: html.includes("最佳擬合傾斜面") || html.includes("Best-Fit Plane"),
                    hasTruck: html.includes("卡車趟數") || html.includes("Trucks"),
                    textLen: html.length
                };
            })()
            """
            check_res = await cdp_call(ws, "Runtime.evaluate", {"expression": check_dom_script, "returnByValue": True}, msg_id=22)
            print("DOM inspection result:", check_res)

            # ---------------------------------------------------------------
            # 1. Dark Theme Capture
            # ---------------------------------------------------------------
            set_dark_theme = """
            (() => {
                document.documentElement.setAttribute("data-theme", "dark");
                document.body.classList.remove("theme-light");
                document.body.classList.add("theme-dark");
                if (typeof window.applyTheme === "function") window.applyTheme("dark");
                const panel = document.getElementById("studioSidePanel");
                if (panel) {
                    panel.classList.add("active");
                    panel.classList.remove("hidden", "mobile-minimized", "gs-panel-minimized");
                    // Scroll to ensure volume results and mass schedule are nicely positioned
                    panel.scrollTop = 380;
                }
                return document.documentElement.getAttribute("data-theme");
            })()
            """
            await cdp_call(ws, "Runtime.evaluate", {"expression": set_dark_theme}, msg_id=25)
            await asyncio.sleep(1.2)

            print("Capturing Dark Theme screenshot...")
            res_dark = await cdp_call(ws, "Page.captureScreenshot", {"format": "png"}, msg_id=30)
            img_b64_dark = res_dark.get("data", "")
            if img_b64_dark:
                raw_dark = base64.b64decode(img_b64_dark)
                with open(OUT_PATH_DARK, "wb") as f_dark:
                    f_dark.write(raw_dark)
                print(f"Saved Dark Theme screenshot: {OUT_PATH_DARK} ({len(raw_dark)} bytes)")

            # Dark theme side panel zoom
            clip_panel = {
                "format": "png",
                "clip": {"x": 1400, "y": 60, "width": 510, "height": 980, "scale": 1.0}
            }
            res_zoom_dark = await cdp_call(ws, "Page.captureScreenshot", clip_panel, msg_id=32)
            if res_zoom_dark.get("data"):
                with open(OUT_PATH_PANEL_ZOOM_DARK, "wb") as f_zd:
                    f_zd.write(base64.b64decode(res_zoom_dark["data"]))
                print(f"Saved side panel zoom (Dark): {OUT_PATH_PANEL_ZOOM_DARK}")

            # Dark theme scrolled down (showing bottom report and CSV buttons)
            scroll_down = """
            (() => {
                const panel = document.getElementById("studioSidePanel");
                if (panel) {
                    panel.scrollTop = 530;
                }
                return 'scrolled_down';
            })()
            """
            await cdp_call(ws, "Runtime.evaluate", {"expression": scroll_down}, msg_id=34)
            await asyncio.sleep(0.8)

            res_dark_scrolled = await cdp_call(ws, "Page.captureScreenshot", {"format": "png"}, msg_id=36)
            if res_dark_scrolled.get("data"):
                with open(OUT_PATH_DARK_SCROLLED, "wb") as f_ds:
                    f_ds.write(base64.b64decode(res_dark_scrolled["data"]))
                print(f"Saved Dark Theme scrolled screenshot: {OUT_PATH_DARK_SCROLLED}")

            # ---------------------------------------------------------------
            # 2. Light Theme Capture
            # ---------------------------------------------------------------
            set_light_theme = """
            (() => {
                document.documentElement.setAttribute("data-theme", "light");
                document.body.classList.remove("theme-dark");
                document.body.classList.add("theme-light");
                if (typeof window.applyTheme === "function") window.applyTheme("light");
                const panel = document.getElementById("studioSidePanel");
                if (panel) {
                    panel.classList.add("active");
                    panel.classList.remove("hidden", "mobile-minimized", "gs-panel-minimized");
                    panel.scrollTop = 380;
                }
                return document.documentElement.getAttribute("data-theme");
            })()
            """
            await cdp_call(ws, "Runtime.evaluate", {"expression": set_light_theme}, msg_id=40)
            await asyncio.sleep(1.2)

            print("Capturing Light Theme screenshot...")
            res_light = await cdp_call(ws, "Page.captureScreenshot", {"format": "png"}, msg_id=45)
            img_b64_light = res_light.get("data", "")
            if img_b64_light:
                raw_light = base64.b64decode(img_b64_light)
                with open(OUT_PATH_LIGHT, "wb") as f_light:
                    f_light.write(raw_light)
                print(f"Saved Light Theme screenshot: {OUT_PATH_LIGHT} ({len(raw_light)} bytes)")

            # Light theme side panel zoom
            res_zoom_light = await cdp_call(ws, "Page.captureScreenshot", clip_panel, msg_id=47)
            if res_zoom_light.get("data"):
                with open(OUT_PATH_PANEL_ZOOM_LIGHT, "wb") as f_zl:
                    f_zl.write(base64.b64decode(res_zoom_light["data"]))
                print(f"Saved side panel zoom (Light): {OUT_PATH_PANEL_ZOOM_LIGHT}")

            # Light theme scrolled down
            await cdp_call(ws, "Runtime.evaluate", {"expression": scroll_down}, msg_id=50)
            await asyncio.sleep(0.8)

            res_light_scrolled = await cdp_call(ws, "Page.captureScreenshot", {"format": "png"}, msg_id=55)
            if res_light_scrolled.get("data"):
                with open(OUT_PATH_LIGHT_SCROLLED, "wb") as f_ls:
                    f_ls.write(base64.b64decode(res_light_scrolled["data"]))
                print(f"Saved Light Theme scrolled screenshot: {OUT_PATH_LIGHT_SCROLLED}")

            print("Done capturing Milestone 1 screenshots!")

    finally:
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


if __name__ == "__main__":
    asyncio.run(capture_m1())
