#!/usr/bin/env python3
"""
Automated Headless Chrome CDP Screenshot Runner for Milestone 7:
Public Utilities GIS Integration with Taiwan Open APIs & Subsurface 3D Digital Twin:
- 10 layer toggles with individual checkboxes, color pills, and real feature counts
- Animated 3D hydraulic flow direction toggle
- MOI NGIS GML 3.1.1, GeoJSON, KML parsing and 3D DXF export controls
- Subsurface cylindrical pipe, box culvert, and manhole 3D rendering
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

OUT_PATH_UTILITIES_DARK = os.path.join(SCREENSHOT_DIR, "m7_utilities_gis_dark.png")
OUT_PATH_UTILITIES_LIGHT = os.path.join(SCREENSHOT_DIR, "m7_utilities_gis_light.png")


async def cdp_call(ws, method, params=None, msg_id=1):
    payload = {"id": msg_id, "method": method, "params": params or {}}
    await ws.send(json.dumps(payload))
    while True:
        resp = json.loads(await ws.recv())
        if resp.get("id") == msg_id:
            return resp.get("result", {})


async def capture_m7():
    port = 9232
    url = "http://127.0.0.1:8095/?scan=rosepark_20260918_merged"
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

            # Dismiss auth gate modal and enter studio
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
            await cdp_call(ws, "Runtime.evaluate", {"expression": dismiss_script}, msg_id=15)

            print("Waiting for 3D Studio scene to initialize...")
            await asyncio.sleep(4.0)

            # Trigger Utilities Inspector and fetch real features
            print("Triggering openUtilitiesInspector and running query...")
            trigger_utilities_script = """
            (async () => {
                if (typeof window.openUtilitiesInspector === 'function') {
                    window.openUtilitiesInspector();
                }
                const btnQuery = document.getElementById("btnUtilQuery");
                if (btnQuery) {
                    btnQuery.click();
                }
                return 'utilities_triggered';
            })()
            """
            res_ut = await cdp_call(ws, "Runtime.evaluate", {"expression": trigger_utilities_script, "returnByValue": True, "awaitPromise": True}, msg_id=20)
            print("Trigger utilities result:", res_ut)

            # Wait for query to complete and 3D geometries to generate
            await asyncio.sleep(5.0)

            # Inspect panel status
            check_script = """
            (() => {
                const feats = window.UTILS_STATE ? window.UTILS_STATE.features.length : 0;
                const panel = document.getElementById("studioSidePanel");
                return {
                    features: feats,
                    panelActive: panel ? panel.classList.contains("active") : false,
                    layers: Object.keys(window.UTILITY_LAYERS || {}).map(k => ({ id: k, count: window.UTILITY_LAYERS[k].count }))
                };
            })()
            """
            check_res = await cdp_call(ws, "Runtime.evaluate", {"expression": check_script, "returnByValue": True}, msg_id=22)
            print("Panel check:", check_res.get("value"))

            # --- Utilities Dark Theme ---
            set_dark = """
            (() => {
                document.documentElement.setAttribute("data-theme", "dark");
                document.body.classList.remove("theme-light");
                document.body.classList.add("theme-dark");
                if (typeof window.applyTheme === "function") window.applyTheme("dark");
                const panel = document.getElementById("studioSidePanel");
                if (panel) {
                    panel.classList.add("active");
                    panel.classList.remove("hidden", "mobile-minimized", "gs-panel-minimized");
                    panel.scrollTop = 0;
                }
                return 'dark_applied';
            })()
            """
            await cdp_call(ws, "Runtime.evaluate", {"expression": set_dark}, msg_id=25)
            await asyncio.sleep(1.0)

            print("Capturing Utilities Dark Theme screenshot...")
            res_sd = await cdp_call(ws, "Page.captureScreenshot", {"format": "png"}, msg_id=30)
            if res_sd.get("data"):
                raw = base64.b64decode(res_sd["data"])
                with open(OUT_PATH_UTILITIES_DARK, "wb") as f:
                    f.write(raw)
                print(f"Saved: {OUT_PATH_UTILITIES_DARK} ({len(raw)} bytes)")

            # --- Utilities Light Theme ---
            set_light = """
            (() => {
                document.documentElement.setAttribute("data-theme", "light");
                document.body.classList.remove("theme-dark");
                document.body.classList.add("theme-light");
                if (typeof window.applyTheme === "function") window.applyTheme("light");
                const panel = document.getElementById("studioSidePanel");
                if (panel) {
                    panel.classList.add("active");
                    panel.classList.remove("hidden", "mobile-minimized", "gs-panel-minimized");
                    panel.scrollTop = 0;
                }
                return 'light_applied';
            })()
            """
            await cdp_call(ws, "Runtime.evaluate", {"expression": set_light}, msg_id=35)
            await asyncio.sleep(1.0)

            print("Capturing Utilities Light Theme screenshot...")
            res_sl = await cdp_call(ws, "Page.captureScreenshot", {"format": "png"}, msg_id=40)
            if res_sl.get("data"):
                raw = base64.b64decode(res_sl["data"])
                with open(OUT_PATH_UTILITIES_LIGHT, "wb") as f:
                    f.write(raw)
                print(f"Saved: {OUT_PATH_UTILITIES_LIGHT} ({len(raw)} bytes)")

            print("Done capturing Milestone 7 screenshots!")

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
    asyncio.run(capture_m7())
