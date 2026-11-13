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
OUT_PATH_MAIN = os.path.join(SCREENSHOT_DIR, "m2_gcp_qa_inspector.png")
OUT_PATH_CARD = os.path.join(SCREENSHOT_DIR, "m2_gcp_qa_tbm_card.png")
OUT_PATH_PANEL = os.path.join(SCREENSHOT_DIR, "m2_gcp_qa_panel_zoom.png")

async def cdp_call(ws, method, params=None, msg_id=1):
    payload = {"id": msg_id, "method": method, "params": params or {}}
    await ws.send(json.dumps(payload))
    while True:
        resp = json.loads(await ws.recv())
        if resp.get("id") == msg_id:
            return resp.get("result", {})

async def capture():
    port = 9222
    url = f"http://127.0.0.1:8095/?scan=quchi_20261005_merged&tool=gcp_qa"
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

            # Dismiss auth gate modal by clicking guest button or closing modal
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

            # Wait for 3D Studio and scan data to load
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

            # Capture full-window screenshot (with 3D Studio and Inspector side panel)
            print("Capturing full-window inspector screenshot...")
            res_shot1 = await cdp_call(ws, "Page.captureScreenshot", {"format": "png"}, msg_id=30)
            img_b64_1 = res_shot1.get("data", "")
            if img_b64_1:
                with open(OUT_PATH_MAIN, "wb") as f1:
                    f1.write(base64.b64decode(img_b64_1))
                print(f"Saved main screenshot to: {OUT_PATH_MAIN} ({os.path.getsize(OUT_PATH_MAIN)} bytes)")

            # Capture zoomed panel screenshot of the right side panel
            print("Capturing side panel zoom screenshot...")
            clip_params = {
                "format": "png",
                "clip": {
                    "x": 1380,
                    "y": 60,
                    "width": 530,
                    "height": 980,
                    "scale": 1.0,
                }
            }
            res_shot_panel = await cdp_call(ws, "Page.captureScreenshot", clip_params, msg_id=35)
            img_b64_panel = res_shot_panel.get("data", "")
            if img_b64_panel:
                with open(OUT_PATH_PANEL, "wb") as fp:
                    fp.write(base64.b64decode(img_b64_panel))
                print(f"Saved side panel zoom to: {OUT_PATH_PANEL} ({os.path.getsize(OUT_PATH_PANEL)} bytes)")

            # Scroll inspector panel down to show TBM Calibration Card and Residuals Table in detail
            scroll_script = """
            (() => {
                const panel = document.getElementById("studioCivilPanel") || document.querySelector(".studio-side-panel");
                if (panel) {
                    panel.scrollTop = 280;
                    return 'scrolled';
                }
                return 'panel_not_found';
            })()
            """
            await cdp_call(ws, "Runtime.evaluate", {"expression": scroll_script}, msg_id=40)
            await asyncio.sleep(1.5)

            # Capture scrolled view
            clip_card = {
                "format": "png",
                "clip": {
                    "x": 1380,
                    "y": 60,
                    "width": 530,
                    "height": 980,
                    "scale": 1.0,
                }
            }
            res_shot2 = await cdp_call(ws, "Page.captureScreenshot", clip_card, msg_id=50)
            img_b64_2 = res_shot2.get("data", "")
            if img_b64_2:
                with open(OUT_PATH_CARD, "wb") as f2:
                    f2.write(base64.b64decode(img_b64_2))
                print(f"Saved TBM card screenshot to: {OUT_PATH_CARD} ({os.path.getsize(OUT_PATH_CARD)} bytes)")

    finally:
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        print("Chrome headless process closed.")

if __name__ == "__main__":
    asyncio.run(capture())
