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

OUT_PATH_DARK = os.path.join(SCREENSHOT_DIR, "m2_gcp_qa_dark_theme.png")
OUT_PATH_LIGHT = os.path.join(SCREENSHOT_DIR, "m2_gcp_qa_light_theme.png")
OUT_PATH_INSPECTOR = os.path.join(SCREENSHOT_DIR, "m2_gcp_qa_inspector.png")
OUT_PATH_PANEL_ZOOM = os.path.join(SCREENSHOT_DIR, "m2_gcp_qa_panel_zoom.png")
OUT_PATH_TBM_CARD = os.path.join(SCREENSHOT_DIR, "m2_gcp_qa_tbm_card.png")
OUT_PATH_DARK_SCROLLED = os.path.join(SCREENSHOT_DIR, "m2_gcp_qa_dark_scrolled.png")
OUT_PATH_LIGHT_SCROLLED = os.path.join(SCREENSHOT_DIR, "m2_gcp_qa_light_scrolled.png")

async def cdp_call(ws, method, params=None, msg_id=1):
    payload = {"id": msg_id, "method": method, "params": params or {}}
    await ws.send(json.dumps(payload))
    while True:
        resp = json.loads(await ws.recv())
        if resp.get("id") == msg_id:
            return resp.get("result", {})

async def capture():
    port = 9224
    url = "http://127.0.0.1:8095/?scan=quchi_20261005_merged&tool=gcp_qa"
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
                    return 'guest_clicked';
                }
                const modal = document.getElementById("userProfileGateModal");
                if (modal) {
                    modal.style.display = 'none';
                    return 'modal_hidden';
                }
                return 'no_modal';
            })()
            """
            res_dismiss = await cdp_call(ws, "Runtime.evaluate", {"expression": dismiss_script}, msg_id=15)
            print("Auth modal dismiss result:", res_dismiss)

            print("Waiting for 3D Studio scene to load...")
            await asyncio.sleep(4.0)

            # Open GCP Accuracy QA Inspector with sample points
            open_script = """
            (() => {
                if (typeof window.openGcpAccuracyQaInspector === 'function') {
                    window.openGcpAccuracyQaInspector();
                    setTimeout(() => {
                        if (typeof window.runEnhancedGcpAccuracyQaEvaluation === 'function') {
                            window.runEnhancedGcpAccuracyQaEvaluation([], { generate_sample_points: true });
                        }
                    }, 500);
                    return 'inspector_opened_and_points_requested';
                }
                return 'not_found';
            })()
            """
            res_eval = await cdp_call(ws, "Runtime.evaluate", {"expression": open_script}, msg_id=20)
            print("Triggered openGcpAccuracyQaInspector():", res_eval)

            # Wait for 3D error vectors and side panel DOM to render
            await asyncio.sleep(4.5)

            # ---------------------------------------------------------------
            # 1. Capture Dark Theme Screenshots
            # ---------------------------------------------------------------
            set_dark_theme = """
            (() => {
                document.documentElement.setAttribute("data-theme", "dark");
                document.body.classList.remove("theme-light");
                document.body.classList.add("theme-dark");
                if (typeof window.setAppTheme === "function") window.setAppTheme("dark");
                const panel = document.querySelector(".gs-side-panel") || document.getElementById("studioSidePanel");
                if (panel) panel.scrollTop = 0;
                return document.documentElement.getAttribute("data-theme");
            })()
            """
            await cdp_call(ws, "Runtime.evaluate", {"expression": set_dark_theme}, msg_id=25)
            await asyncio.sleep(1.0)

            print("Capturing Dark Theme main screenshot...")
            res_dark = await cdp_call(ws, "Page.captureScreenshot", {"format": "png"}, msg_id=30)
            img_b64_dark = res_dark.get("data", "")
            if img_b64_dark:
                raw_dark = base64.b64decode(img_b64_dark)
                with open(OUT_PATH_DARK, "wb") as f_dark:
                    f_dark.write(raw_dark)
                with open(OUT_PATH_INSPECTOR, "wb") as f_insp:
                    f_insp.write(raw_dark)
                print(f"Saved Dark Theme screenshot: {OUT_PATH_DARK}")

            # Dark theme side panel zoom
            clip_panel = {
                "format": "png",
                "clip": {"x": 1400, "y": 60, "width": 510, "height": 980, "scale": 1.0}
            }
            res_zoom = await cdp_call(ws, "Page.captureScreenshot", clip_panel, msg_id=32)
            if res_zoom.get("data"):
                with open(OUT_PATH_PANEL_ZOOM, "wb") as f_z:
                    f_z.write(base64.b64decode(res_zoom["data"]))
                print(f"Saved side panel zoom: {OUT_PATH_PANEL_ZOOM}")

            # Scroll down to show table, scale select, and export buttons
            scroll_down = """
            (() => {
                const panel = document.querySelector(".gs-side-panel") || document.getElementById("studioSidePanel");
                if (panel) {
                    panel.scrollTop = 420;
                    return 'scrolled_' + panel.scrollTop;
                }
                return 'not_found';
            })()
            """
            await cdp_call(ws, "Runtime.evaluate", {"expression": scroll_down}, msg_id=34)
            await asyncio.sleep(0.8)

            res_dark_scrolled = await cdp_call(ws, "Page.captureScreenshot", {"format": "png"}, msg_id=36)
            if res_dark_scrolled.get("data"):
                with open(OUT_PATH_DARK_SCROLLED, "wb") as f_ds:
                    f_ds.write(base64.b64decode(res_dark_scrolled["data"]))
                print(f"Saved Dark Theme scrolled screenshot: {OUT_PATH_DARK_SCROLLED}")

            # Also capture TBM card zoom
            res_tbm_card = await cdp_call(ws, "Page.captureScreenshot", clip_panel, msg_id=38)
            if res_tbm_card.get("data"):
                with open(OUT_PATH_TBM_CARD, "wb") as f_tbm:
                    f_tbm.write(base64.b64decode(res_tbm_card["data"]))
                print(f"Saved TBM card zoom: {OUT_PATH_TBM_CARD}")

            # ---------------------------------------------------------------
            # 2. Switch to Bright / Light Theme & Capture Screenshots
            # ---------------------------------------------------------------
            set_light_theme_top = """
            (() => {
                document.documentElement.setAttribute("data-theme", "light");
                document.body.classList.remove("theme-dark");
                document.body.classList.add("theme-light");
                if (typeof window.setAppTheme === "function") window.setAppTheme("light");
                const panel = document.querySelector(".gs-side-panel") || document.getElementById("studioSidePanel");
                if (panel) panel.scrollTop = 0;
                return document.documentElement.getAttribute("data-theme");
            })()
            """
            await cdp_call(ws, "Runtime.evaluate", {"expression": set_light_theme_top}, msg_id=40)
            await asyncio.sleep(1.2)

            print("Capturing Light Theme main screenshot...")
            res_light = await cdp_call(ws, "Page.captureScreenshot", {"format": "png"}, msg_id=45)
            if res_light.get("data"):
                with open(OUT_PATH_LIGHT, "wb") as f_light:
                    f_light.write(base64.b64decode(res_light["data"]))
                print(f"Saved Light Theme screenshot: {OUT_PATH_LIGHT}")

            # Scroll down in light theme
            await cdp_call(ws, "Runtime.evaluate", {"expression": scroll_down}, msg_id=50)
            await asyncio.sleep(0.8)

            res_light_scrolled = await cdp_call(ws, "Page.captureScreenshot", {"format": "png"}, msg_id=55)
            if res_light_scrolled.get("data"):
                with open(OUT_PATH_LIGHT_SCROLLED, "wb") as f_ls:
                    f_ls.write(base64.b64decode(res_light_scrolled["data"]))
                print(f"Saved Light Theme scrolled screenshot: {OUT_PATH_LIGHT_SCROLLED}")

            print("All dual-theme visual verification screenshots captured successfully!")

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
    asyncio.run(capture())
