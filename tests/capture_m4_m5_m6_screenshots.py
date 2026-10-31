#!/usr/bin/env python3
"""
Automated Headless Chrome CDP Screenshot Runner for Milestones 4, 5, and 6:
1. Milestone 4:
   - m4_flatness_plumb_dark.png (Flatness/Plumbness Inspector in Dark Theme)
   - m4_flatness_plumb_light.png (Flatness/Plumbness Inspector in Light Theme)
   - m4_trench_utility_dark.png (Open-Trench Utility Tracer in Dark Theme)
   - m4_trench_utility_light.png (Open-Trench Utility Tracer in Light Theme)
2. Milestone 5:
   - m5_compare_delta_v_dark.png (Compare View ΔV Volume Takeoff in Dark Theme)
   - m5_compare_delta_v_light.png (Compare View ΔV Volume Takeoff in Light Theme)
   - m5_stakeout_dark.png (RTK Stakeout Field Sheet in Dark Theme)
   - m5_stakeout_light.png (RTK Stakeout Field Sheet in Light Theme)
3. Milestone 6:
   - m6_scan_to_bim_dark.png (Scan-to-BIM 3D Primitives Overlay in Dark Theme)
   - m6_scan_to_bim_light.png (Scan-to-BIM 3D Primitives Overlay in Light Theme)

All captured in high-resolution 1920x1080 with WebGL enabled against local server http://127.0.0.1:8095.
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

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
SCREENSHOT_DIR = r"c:\Antigravity\GatheringScans\.agents\teamwork\screenshots"
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

TARGET_FILES = {
    "m4_flatness_plumb_dark": os.path.join(SCREENSHOT_DIR, "m4_flatness_plumb_dark.png"),
    "m4_flatness_plumb_light": os.path.join(SCREENSHOT_DIR, "m4_flatness_plumb_light.png"),
    "m4_trench_utility_dark": os.path.join(SCREENSHOT_DIR, "m4_trench_utility_dark.png"),
    "m4_trench_utility_light": os.path.join(SCREENSHOT_DIR, "m4_trench_utility_light.png"),
    "m5_compare_delta_v_dark": os.path.join(SCREENSHOT_DIR, "m5_compare_delta_v_dark.png"),
    "m5_compare_delta_v_light": os.path.join(SCREENSHOT_DIR, "m5_compare_delta_v_light.png"),
    "m5_stakeout_dark": os.path.join(SCREENSHOT_DIR, "m5_stakeout_dark.png"),
    "m5_stakeout_light": os.path.join(SCREENSHOT_DIR, "m5_stakeout_light.png"),
    "m6_scan_to_bim_dark": os.path.join(SCREENSHOT_DIR, "m6_scan_to_bim_dark.png"),
    "m6_scan_to_bim_light": os.path.join(SCREENSHOT_DIR, "m6_scan_to_bim_light.png"),
}


async def cdp_call(ws, method, params=None, msg_id=1):
    payload = {"id": msg_id, "method": method, "params": params or {}}
    await ws.send(json.dumps(payload))
    while True:
        resp = json.loads(await ws.recv())
        if resp.get("id") == msg_id:
            return resp.get("result", {})


async def apply_theme(ws, theme_name, msg_base=100):
    script = f"""
    (() => {{
        const theme = "{theme_name}";
        document.documentElement.setAttribute("data-theme", theme);
        if (theme === "dark") {{
            document.body.classList.remove("theme-light");
            document.body.classList.add("theme-dark");
        }} else {{
            document.body.classList.remove("theme-dark");
            document.body.classList.add("theme-light");
        }}
        if (typeof window.applyTheme === "function") {{
            window.applyTheme(theme);
        }}
        const panel = document.getElementById("studioSidePanel");
        if (panel) {{
            panel.classList.add("active", "open");
            panel.classList.remove("hidden", "mobile-minimized", "gs-panel-minimized");
            panel.scrollTop = 0;
        }}
        return '{theme_name}_applied';
    }})()
    """
    await cdp_call(ws, "Runtime.evaluate", {"expression": script}, msg_id=msg_base)
    await asyncio.sleep(1.2)


async def take_screenshot(ws, output_path, msg_id=200):
    res = await cdp_call(ws, "Page.captureScreenshot", {"format": "png"}, msg_id=msg_id)
    if res.get("data"):
        raw = base64.b64decode(res["data"])
        with open(output_path, "wb") as f:
            f.write(raw)
        size_kb = len(raw) / 1024.0
        print(f"Captured: {os.path.basename(output_path)} -> {len(raw)} bytes ({size_kb:.1f} KB)")
        if len(raw) < 500 * 1024:
            print(f"WARNING: File size {len(raw)} bytes is below 500 KB threshold!")
        return len(raw)
    else:
        raise RuntimeError(f"CDP captureScreenshot returned empty data for {output_path}")


async def capture_all():
    port = 9235
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

            print("Waiting for initial page load...")
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

            # =================================================================
            # 1. MILESTONE 4: Surface Flatness & Plumbness Inspector
            # =================================================================
            print("\n--- 1. Milestone 4: Surface Flatness & Plumbness ---")
            setup_flatness = """
            (() => {
                if (typeof window.openSurfaceFlatnessQaInspector === 'function') {
                    window.openSurfaceFlatnessQaInspector();
                    const btn = document.getElementById('btnRunSurfaceQa');
                    if (btn) btn.click();
                    return 'flatness_triggered';
                }
                return 'openSurfaceFlatnessQaInspector_missing';
            })()
            """
            res_fl = await cdp_call(ws, "Runtime.evaluate", {"expression": setup_flatness, "returnByValue": True}, msg_id=30)
            print("Flatness trigger result:", res_fl)
            await asyncio.sleep(4.0)

            # Dark Theme
            await apply_theme(ws, "dark", msg_base=40)
            await take_screenshot(ws, TARGET_FILES["m4_flatness_plumb_dark"], msg_id=50)

            # Light Theme
            await apply_theme(ws, "light", msg_base=60)
            await take_screenshot(ws, TARGET_FILES["m4_flatness_plumb_light"], msg_id=70)

            # =================================================================
            # 2. MILESTONE 4: Open-Trench Utility Tracer
            # =================================================================
            print("\n--- 2. Milestone 4: Open-Trench Utility Tracer ---")
            setup_utility = """
            (() => {
                if (typeof window.openUtilityTracerInspector === 'function') {
                    window.openUtilityTracerInspector();
                    const btn = document.getElementById('btnTraceUtility');
                    if (btn) btn.click();
                    return 'utility_triggered';
                }
                return 'openUtilityTracerInspector_missing';
            })()
            """
            res_ut = await cdp_call(ws, "Runtime.evaluate", {"expression": setup_utility, "returnByValue": True}, msg_id=80)
            print("Utility trigger result:", res_ut)
            await asyncio.sleep(4.0)

            # Dark Theme
            await apply_theme(ws, "dark", msg_base=90)
            await take_screenshot(ws, TARGET_FILES["m4_trench_utility_dark"], msg_id=100)

            # Light Theme
            await apply_theme(ws, "light", msg_base=110)
            await take_screenshot(ws, TARGET_FILES["m4_trench_utility_light"], msg_id=120)

            # =================================================================
            # 3. MILESTONE 5: Compare View Delta V Volume Takeoff
            # =================================================================
            print("\n--- 3. Milestone 5: Compare View Delta V Volume Takeoff ---")
            setup_compare = """
            (() => {
                if (typeof window.openCompareVolumeTakeoffInspector === 'function') {
                    if (window.STATE) {
                        window.STATE.compareBaseScanId = 'ntudorm_20260915_baseline';
                        window.STATE.compareScanId = 'rosepark_20260918_merged';
                    }
                    window.openCompareVolumeTakeoffInspector();
                    const btn = document.getElementById('btnRunCompareVolume');
                    if (btn) btn.click();
                    return 'compare_volume_triggered';
                }
                return 'openCompareVolumeTakeoffInspector_missing';
            })()
            """
            res_cv = await cdp_call(ws, "Runtime.evaluate", {"expression": setup_compare, "returnByValue": True}, msg_id=130)
            print("Compare volume trigger result:", res_cv)
            await asyncio.sleep(4.0)

            # Dark Theme
            await apply_theme(ws, "dark", msg_base=140)
            await take_screenshot(ws, TARGET_FILES["m5_compare_delta_v_dark"], msg_id=150)

            # Light Theme
            await apply_theme(ws, "light", msg_base=160)
            await take_screenshot(ws, TARGET_FILES["m5_compare_delta_v_light"], msg_id=170)

            # =================================================================
            # 4. MILESTONE 5: RTK Stakeout Field Sheet
            # =================================================================
            print("\n--- 4. Milestone 5: RTK Stakeout Field Sheet ---")
            setup_stakeout = """
            (() => {
                if (typeof window.openRtkStakeoutInspector === 'function') {
                    window.openRtkStakeoutInspector();
                    const btn = document.getElementById('btnGenStakeout');
                    if (btn) btn.click();
                    return 'stakeout_triggered';
                }
                return 'openRtkStakeoutInspector_missing';
            })()
            """
            res_so = await cdp_call(ws, "Runtime.evaluate", {"expression": setup_stakeout, "returnByValue": True}, msg_id=180)
            print("Stakeout trigger result:", res_so)
            await asyncio.sleep(4.0)

            # Dark Theme
            await apply_theme(ws, "dark", msg_base=190)
            await take_screenshot(ws, TARGET_FILES["m5_stakeout_dark"], msg_id=200)

            # Light Theme
            await apply_theme(ws, "light", msg_base=210)
            await take_screenshot(ws, TARGET_FILES["m5_stakeout_light"], msg_id=220)

            # =================================================================
            # 5. MILESTONE 6: Scan-to-BIM 3D Primitives Overlay
            # =================================================================
            print("\n--- 5. Milestone 6: Scan-to-BIM 3D Primitives Overlay ---")
            setup_bim = """
            (() => {
                if (typeof window.openScanToBimInspector === 'function') {
                    window.openScanToBimInspector();
                    if (window.__GS_BIM && typeof window.__GS_BIM.toggleOverlay === 'function') {
                        window.__GS_BIM.toggleOverlay(true);
                    }
                    return 'bim_triggered';
                }
                return 'openScanToBimInspector_missing';
            })()
            """
            res_bim = await cdp_call(ws, "Runtime.evaluate", {"expression": setup_bim, "returnByValue": True}, msg_id=230)
            print("Scan-to-BIM trigger result:", res_bim)
            await asyncio.sleep(5.0)

            # Ensure overlay is definitely enabled
            enable_overlay_script = """
            (() => {
                if (window.__GS_BIM && typeof window.__GS_BIM.toggleOverlay === 'function') {
                    window.__GS_BIM.toggleOverlay(true);
                }
                return 'overlay_forced';
            })()
            """
            await cdp_call(ws, "Runtime.evaluate", {"expression": enable_overlay_script}, msg_id=240)
            await asyncio.sleep(1.0)

            # Dark Theme
            await apply_theme(ws, "dark", msg_base=250)
            await take_screenshot(ws, TARGET_FILES["m6_scan_to_bim_dark"], msg_id=260)

            # Light Theme
            await apply_theme(ws, "light", msg_base=270)
            await take_screenshot(ws, TARGET_FILES["m6_scan_to_bim_light"], msg_id=280)

            print("\nAll 10 dual-theme screenshots successfully captured!")

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
    asyncio.run(capture_all())
