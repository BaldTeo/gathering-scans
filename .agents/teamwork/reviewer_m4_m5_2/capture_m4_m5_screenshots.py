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

async def cdp_call(ws, method, params=None, msg_id=1):
    payload = {"id": msg_id, "method": method, "params": params or {}}
    await ws.send(json.dumps(payload))
    while True:
        resp = json.loads(await ws.recv())
        if resp.get("id") == msg_id:
            return resp.get("result", {})

async def capture_m4_m5():
    port = 9225
    url = "http://127.0.0.1:8095/?scan=quchi_20261005_merged"
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

            print("Waiting for page load & dismissing auth gate...")
            await asyncio.sleep(4.0)

            dismiss_script = """
            (() => {
                const btnGuest = document.getElementById("btnGateGuestEnter");
                if (btnGuest) { btnGuest.click(); return 'guest_clicked'; }
                const modal = document.getElementById("userProfileGateModal");
                if (modal) { modal.style.display = 'none'; return 'modal_hidden'; }
                return 'no_modal';
            })()
            """
            await cdp_call(ws, "Runtime.evaluate", {"expression": dismiss_script}, msg_id=15)
            await asyncio.sleep(3.5)

            # Tools to test:
            # 1. Surface QA Flatness
            # 2. Utility Tracer
            # 3. Compare Volume Takeoff
            # 4. RTK Stakeout
            tools = [
                ("surface_qa", "window.openSurfaceFlatnessQaInspector()", "m4_surface_qa"),
                ("utility_trace", "window.openUtilityTracerInspector()", "m4_utility_trace"),
                ("compare_volume", "window.openCompareVolumeTakeoffInspector()", "m5_compare_volume"),
                ("rtk_stakeout", "window.openRtkStakeoutInspector()", "m5_rtk_stakeout"),
            ]

            layout_report = {}

            for tool_name, trigger_code, out_prefix in tools:
                print(f"\n--- Testing Tool: {tool_name} ---")
                open_code = f"""
                (() => {{
                    {trigger_code};
                    return 'opened_{tool_name}';
                }})()
                """
                res_open = await cdp_call(ws, "Runtime.evaluate", {"expression": open_code}, msg_id=100)
                print(f"Triggered {tool_name}:", res_open)
                await asyncio.sleep(1.5)

                # Check layout & horizontal overflow
                check_layout_script = """
                (() => {
                    const panel = document.querySelector(".gs-side-panel") || document.getElementById("studioSidePanel");
                    if (!panel) return { error: "panel not found" };
                    const hasHorizontalScroll = panel.scrollWidth > panel.clientWidth;
                    const diff = panel.scrollWidth - panel.clientWidth;
                    const container = panel.querySelector(".gs-qa-container");
                    const tables = panel.querySelectorAll(".gs-qa-table");
                    let tableOverviews = [];
                    tables.forEach((t, i) => {
                        const parent = t.parentElement;
                        tableOverviews.push({
                            index: i,
                            tableScrollWidth: t.scrollWidth,
                            tableClientWidth: t.clientWidth,
                            parentScrollWidth: parent ? parent.scrollWidth : 0,
                            parentClientWidth: parent ? parent.clientWidth : 0,
                        });
                    });
                    return {
                        panelWidth: panel.clientWidth,
                        panelScrollWidth: panel.scrollWidth,
                        hasHorizontalScroll: hasHorizontalScroll,
                        diff: diff,
                        containerScrollWidth: container ? container.scrollWidth : 0,
                        containerClientWidth: container ? container.clientWidth : 0,
                        tables: tableOverviews
                    };
                })()
                """
                res_layout = await cdp_call(ws, "Runtime.evaluate", {"expression": check_layout_script, "returnByValue": True}, msg_id=105)
                layout_data = res_layout.get("result", {}).get("value", {})
                layout_report[tool_name] = layout_data
                print(f"Layout data for {tool_name}:", json.dumps(layout_data, indent=2))

                # Check emojis in panel
                check_emoji_script = """
                (() => {
                    const panel = document.querySelector(".gs-side-panel") || document.getElementById("studioSidePanel");
                    if (!panel) return { count: 0, matches: [] };
                    const text = panel.innerHTML;
                    const pat = /[\\u{1F300}-\\u{1F9FF}]|[\\u{2600}-\\u{26FF}]|[\\u{2700}-\\u{27BF}]|[\\u{2B50}-\\u{2B55}]/u;
                    const matches = [];
                    for (const char of text) {
                        if (pat.test(char)) matches.push(char);
                    }
                    return { count: matches.length, matches: matches.slice(0, 10) };
                })()
                """
                res_emoji = await cdp_call(ws, "Runtime.evaluate", {"expression": check_emoji_script, "returnByValue": True}, msg_id=110)
                emoji_data = res_emoji.get("result", {}).get("value", {})
                print(f"Emoji check in rendered DOM for {tool_name}:", emoji_data)

                # 1. Dark Theme Screenshot
                set_dark = """
                (() => {
                    document.documentElement.setAttribute("data-theme", "dark");
                    document.body.classList.remove("theme-light");
                    document.body.classList.add("theme-dark");
                    if (typeof window.setAppTheme === "function") window.setAppTheme("dark");
                    return 'dark_set';
                })()
                """
                await cdp_call(ws, "Runtime.evaluate", {"expression": set_dark}, msg_id=120)
                await asyncio.sleep(0.8)

                # Capture full window
                dark_path = os.path.join(SCREENSHOT_DIR, f"{out_prefix}_dark.png")
                res_shot_dark = await cdp_call(ws, "Page.captureScreenshot", {"format": "png"}, msg_id=125)
                if res_shot_dark.get("data"):
                    with open(dark_path, "wb") as f:
                        f.write(base64.b64decode(res_shot_dark["data"]))
                    print(f"Saved {dark_path}")

                # Capture panel zoom
                clip_panel = {
                    "format": "png",
                    "clip": {"x": 1380, "y": 60, "width": 530, "height": 960, "scale": 1.0}
                }
                dark_zoom_path = os.path.join(SCREENSHOT_DIR, f"{out_prefix}_dark_panel.png")
                res_zoom_dark = await cdp_call(ws, "Page.captureScreenshot", clip_panel, msg_id=128)
                if res_zoom_dark.get("data"):
                    with open(dark_zoom_path, "wb") as f:
                        f.write(base64.b64decode(res_zoom_dark["data"]))
                    print(f"Saved {dark_zoom_path}")

                # 2. Light Theme Screenshot
                set_light = """
                (() => {
                    document.documentElement.setAttribute("data-theme", "light");
                    document.body.classList.remove("theme-dark");
                    document.body.classList.add("theme-light");
                    if (typeof window.setAppTheme === "function") window.setAppTheme("light");
                    return 'light_set';
                })()
                """
                await cdp_call(ws, "Runtime.evaluate", {"expression": set_light}, msg_id=130)
                await asyncio.sleep(0.8)

                light_path = os.path.join(SCREENSHOT_DIR, f"{out_prefix}_light.png")
                res_shot_light = await cdp_call(ws, "Page.captureScreenshot", {"format": "png"}, msg_id=135)
                if res_shot_light.get("data"):
                    with open(light_path, "wb") as f:
                        f.write(base64.b64decode(res_shot_light["data"]))
                    print(f"Saved {light_path}")

                light_zoom_path = os.path.join(SCREENSHOT_DIR, f"{out_prefix}_light_panel.png")
                res_zoom_light = await cdp_call(ws, "Page.captureScreenshot", clip_panel, msg_id=138)
                if res_zoom_light.get("data"):
                    with open(light_zoom_path, "wb") as f:
                        f.write(base64.b64decode(res_zoom_light["data"]))
                    print(f"Saved {light_zoom_path}")

            with open(os.path.join(r"c:\Antigravity\GatheringScans\.agents\teamwork\reviewer_m4_m5_2", "layout_report.json"), "w", encoding="utf-8") as f_rep:
                json.dump(layout_report, f_rep, indent=2)
            print("\nAll screenshots and layout report successfully generated!")

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
    asyncio.run(capture_m4_m5())
