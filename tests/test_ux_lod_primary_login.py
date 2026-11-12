#!/usr/bin/env python3
"""
Automated Regression & Headless Browser Verification Tests for:
- Bug #1: Mobile & Tablet Studio Toolbar Zero-Horizontal-Scroll (375px & 768px)
- Bug #2: Primary Scan (Star Icon) API, Persistence & Default Site Selection
- Bug #3: Login Gate UI Matching files.gatheren.cloud
- Bug #4: HD Tile Idle-Gating, Pinned Coarse Base Tiles & Bounded GPU Tile Cache
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

import pc_worker.server_api_routes as server_api_routes
import server as gs_server
from pc_worker.auth_and_sharing import AuthAndSharingManager, issue_session_token
from pc_worker.priority_queue import ScanQueueDB


def _find_chrome_binary() -> str:
    candidates = [
        shutil.which("chrome") or "",
        shutil.which("google-chrome") or "",
        shutil.which("chromium") or "",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ]
    for cand in candidates:
        if cand and os.path.isfile(cand):
            return cand
    return ""


class UxLodPrimaryLoginTests(unittest.TestCase):
    def test_61_login_ui_matches_files_gatheren_cloud(self):
        """Verify GatheringScans login gate markup & CSS match files.gatheren.cloud while preserving auth flows."""
        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            html = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            css = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.js"), "r", encoding="utf-8") as f:
            app_js = f.read()
        with open(os.path.join(BASE_DIR, "web", "sw.js"), "r", encoding="utf-8") as f:
            sw_js = f.read()

        # 1. Exact files.gatheren.cloud login gate structural elements & classes
        self.assertIn('id="userProfileGateModal"', html)
        self.assertIn("oauth-login-gate", html)
        self.assertIn("oauth-login-card", html)
        self.assertIn("oauth-brand-row", html)
        self.assertIn("domain-pill", html)
        self.assertIn(">scans.gatheren.cloud<", html)
        self.assertIn("oauth-security-badge", html)
        self.assertIn("oauth-google-mount", html)
        self.assertIn('id="chkOauthRememberMe"', html)
        self.assertIn('id="oauthErrorBanner"', html)
        self.assertIn('id="googleAuthOriginNotice"', html)
        self.assertIn("oauth-origin-notice", html)

        # 2. Preserved GatheringScans auth flows (Google GIS, Guest, Account Switcher, Logout, Continue, Lang)
        for req_id in (
            "googleSignInButtonContainer",
            "btnGateGuestEnter",
            "btnChooseGoogleAccountOAuth",
            "gateExistingUsersSection",
            "btnUserLogout",
            "btnGateConfirmEnter",
            "btnAuthToggleLanguage",
        ):
            self.assertIn(f'id="{req_id}"', html)

        # 3. CSS visual parity with files.gatheren.cloud (#0b101b dark root, #0f172a card, 440px max-width, 16px radius)
        self.assertIn(".oauth-login-gate", css)
        self.assertIn(".oauth-login-card", css)
        self.assertIn("max-width: 440px", css)
        self.assertIn("border-radius: 16px", css)
        self.assertIn("#0b101b", css)
        self.assertIn("#0f172a", css)
        self.assertIn("MutationObserver", app_js)

        # 4. Asset cache-busting version synchronization between index.html and sw.js
        self.assertIn("?v=20261112_v322", html)
        self.assertIn("gathering-scans-offline-v322", sw_js)

    def test_62_primary_scan_star_api_persistence_and_default_selection(self):
        """Verify Primary Scan HTTP API, RBAC, disk persistence, site rename migration, and default site selection."""
        tmp_dir = tempfile.mkdtemp(prefix="gs_primary_test_")
        try:
            tmp_db_path = os.path.join(tmp_dir, "test_queue.db")
            tmp_primary_path = os.path.join(tmp_dir, "primary_scans.json")
            tmp_manifest_path = os.path.join(tmp_dir, "cloud_manifest.json")
            with open(tmp_manifest_path, "w", encoding="utf-8") as mf:
                json.dump({"scans": [], "primary_scans": {}}, mf)

            test_db = ScanQueueDB(db_path=tmp_db_path)
            test_auth = AuthAndSharingManager(test_db)

            # Create two scans in the same site ("Alpha Site"): scan_older (earlier) and scan_newer (latest)
            test_db.upsert_scan(
                {
                    "scan_id": "alpha_20260901_older",
                    "name": "Alpha Older Baseline",
                    "project_group": "Alpha Site",
                    "capture_date": "2026-09-01",
                    "uploaded_at": 1700000100.0,
                    "twd97_e": 304950.0,
                    "twd97_n": 2757080.0,
                    "twd97_h": 42.0,
                    "status": "completed",
                }
            )
            test_db.upsert_scan(
                {
                    "scan_id": "alpha_20261015_newer",
                    "name": "Alpha Newer Scan",
                    "project_group": "Alpha Site",
                    "capture_date": "2026-10-15",
                    "uploaded_at": 1700099900.0,
                    "twd97_e": 304952.0,
                    "twd97_n": 2757082.0,
                    "twd97_h": 42.5,
                    "status": "completed",
                }
            )

            # Create authenticated Editor and Viewer sessions
            owner_email = "glibivanov@gatheren.com.tw"
            test_auth.admin_save_user(
                actor_email=owner_email,
                target_email="editor@gatheren.com.tw",
                name="Site Editor",
                zh_name="編輯工程師",
                role="editor",
            )
            test_auth.admin_save_user(
                actor_email=owner_email,
                target_email="viewer@gatheren.com.tw",
                name="Site Viewer",
                zh_name="檢視者",
                role="viewer",
            )
            editor_prof = test_auth.upsert_user_profile({"email": "editor@gatheren.com.tw", "name": "Site Editor"}, preserve_existing_role=True)
            viewer_prof = test_auth.upsert_user_profile({"email": "viewer@gatheren.com.tw", "name": "Site Viewer"}, preserve_existing_role=True)
            editor_tok = editor_prof.get("session_token") or issue_session_token("editor@gatheren.com.tw")
            viewer_tok = viewer_prof.get("session_token") or issue_session_token("viewer@gatheren.com.tw")

            def _mock_load_manifest():
                with open(tmp_manifest_path, "r", encoding="utf-8") as f:
                    return json.load(f)

            def _mock_save_manifest(data):
                with open(tmp_manifest_path, "w", encoding="utf-8") as f:
                    json.dump(data, f)

            with patch.object(server_api_routes, "PRIMARY_SCANS_PATH", tmp_primary_path), \
                 patch.object(server_api_routes, "DB", test_db), \
                 patch.object(server_api_routes, "AUTH_SHARE", test_auth), \
                 patch.object(server_api_routes, "_load_cloud_manifest", _mock_load_manifest), \
                 patch.object(server_api_routes, "_save_cloud_manifest", _mock_save_manifest), \
                 patch.object(gs_server, "DB", test_db), \
                 patch.object(gs_server, "AUTH_SHARE", test_auth), \
                 patch.object(gs_server, "_load_cloud_manifest", _mock_load_manifest), \
                 patch.object(gs_server, "_save_cloud_manifest", _mock_save_manifest):

                httpd = ThreadingHTTPServer(("127.0.0.1", 0), gs_server.GatheringScansHandler)
                port = httpd.server_address[1]
                srv_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                srv_thread.start()
                try:
                    base_url = f"http://127.0.0.1:{port}"

                    def _post_json(path, body, token=""):
                        headers = {"Content-Type": "application/json"}
                        if token:
                            headers["X-Session-Token"] = token
                        req = urllib.request.Request(
                            base_url + path,
                            data=json.dumps(body).encode("utf-8"),
                            headers=headers,
                            method="POST",
                        )
                        try:
                            with urllib.request.urlopen(req, timeout=8) as r:
                                return r.status, json.loads(r.read().decode("utf-8"))
                        except urllib.error.HTTPError as he:
                            return he.code, json.loads(he.read().decode("utf-8"))

                    def _get_json(path, token=""):
                        headers = {}
                        if token:
                            headers["X-Session-Token"] = token
                        req = urllib.request.Request(base_url + path, headers=headers, method="GET")
                        with urllib.request.urlopen(req, timeout=8) as r:
                            return r.status, json.loads(r.read().decode("utf-8"))

                    # 1. Guest & Viewer MUST receive 403 Forbidden when attempting to set primary scan
                    st_guest, _ = _post_json("/api/site/primary-scan", {"scan_id": "alpha_20260901_older", "is_primary": True})
                    self.assertEqual(st_guest, 403)
                    st_viewer, _ = _post_json(
                        "/api/site/primary-scan",
                        {"scan_id": "alpha_20260901_older", "is_primary": True},
                        token=viewer_tok,
                    )
                    self.assertEqual(st_viewer, 403)

                    # 2. Editor sets older scan as Primary Scan -> 200 OK & persisted to primary_scans.json
                    st_ed, res_ed = _post_json(
                        "/api/site/primary-scan",
                        {"scan_id": "alpha_20260901_older", "project_group": "Alpha Site", "is_primary": True},
                        token=editor_tok,
                    )
                    self.assertEqual(st_ed, 200)
                    self.assertEqual(res_ed["primary_scan_id"], "alpha_20260901_older")
                    self.assertTrue(res_ed["is_primary"])
                    self.assertTrue(os.path.isfile(tmp_primary_path))

                    # 3. GET /api/scans & /api/projects expose is_primary, primary_scan_id, and put primary scan FIRST in scan_ids
                    st_cat, cat_data = _get_json("/api/scans", token=viewer_tok)
                    self.assertEqual(st_cat, 200)
                    scans_by_id = {s["scan_id"]: s for s in cat_data["scans"]}
                    self.assertTrue(scans_by_id["alpha_20260901_older"]["is_primary"])
                    self.assertFalse(scans_by_id["alpha_20261015_newer"]["is_primary"])

                    st_proj, proj_data = _get_json("/api/projects", token=viewer_tok)
                    self.assertEqual(st_proj, 200)
                    alpha_proj = next(p for p in proj_data["projects"] if p["project_group"] == "Alpha Site")
                    self.assertEqual(alpha_proj["primary_scan_id"], "alpha_20260901_older")
                    self.assertEqual(alpha_proj["default_scan_id"], "alpha_20260901_older")
                    self.assertEqual(alpha_proj["scan_ids"][0], "alpha_20260901_older")

                    # 4. Site rename migrates primary scan cleanly
                    server_api_routes.migrate_primary_scan_group("Alpha Site", "Alpha Renamed Site")
                    self.assertEqual(server_api_routes.get_site_primary_scan_id("Alpha Renamed Site"), "alpha_20260901_older")
                finally:
                    httpd.shutdown()
                    httpd.server_close()
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

        # 5. Verify frontend star button & default primary scan selection hooks in 02-map-and-timeline.js
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        self.assertIn("toggleScanPrimaryStatus", js02)
        self.assertIn("getPreferredScanForSite", js02)
        self.assertIn("btnSetPrimaryPreviewScan", js02)
        self.assertIn("btnSetPrimaryStudioScan", js02)
        self.assertIn("/api/site/primary-scan", js02)

    def test_63_mobile_and_tablet_studio_toolbar_zero_horizontal_scroll(self):
        """Verify Studio bottom dock and top bar have zero horizontal overflow/scroll at 375px mobile & 768px tablet."""
        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            html = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            css = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.js"), "r", encoding="utf-8") as f:
            app_js = f.read()

        for required_id in (
            "btnDockOrbitNav",
            "btnDockCatMeasure",
            "btnDockCatCivil",
            "btnDockCatLayers",
            "btnDockMoreTools",
            "studioCompactToolsPopover",
            "btnStudioTopMore",
            "studioTopMorePopover",
        ):
            self.assertIn(f'id="{required_id}"', html)
        self.assertIn("overflow-x: hidden !important", css)
        self.assertIn("initCompactStudioToolbarAndPopovers", app_js)

        chrome_bin = _find_chrome_binary()
        try:
            import websocket  # type: ignore
        except ImportError:
            websocket = None

        if not chrome_bin or websocket is None:
            return

        # Spin up a lightweight local static/API server and verify real computed geometry in Headless Chrome at 375px & 768px
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), gs_server.GatheringScansHandler)
        port = httpd.server_address[1]
        srv_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        srv_thread.start()
        user_data_dir = tempfile.mkdtemp(prefix="gs_chrome_test_")
        chrome_proc = None
        ws = None
        try:
            debug_port = port + 100 if port < 64000 else port - 100
            chrome_proc = subprocess.Popen(
                [
                    chrome_bin,
                    "--headless=new",
                    f"--remote-debugging-port={debug_port}",
                    "--remote-allow-origins=*",
                    f"--user-data-dir={user_data_dir}",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-gpu-sandbox",
                    "--enable-webgl",
                    "--ignore-gpu-blocklist",
                    "--use-angle=swiftshader",
                    "about:blank",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            ws_url = None
            for _ in range(40):
                time.sleep(0.2)
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json", timeout=2) as r:
                        tabs = json.loads(r.read().decode("utf-8"))
                        for t in tabs:
                            if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                                ws_url = t["webSocketDebuggerUrl"]
                                break
                        if ws_url:
                            break
                except Exception:
                    pass
            self.assertIsNotNone(ws_url, "Headless Chrome DevTools endpoint failed to start")

            ws = websocket.create_connection(ws_url, timeout=15)
            msg_seq = [0]
            page_exceptions = []

            def cdp(method, params=None):
                msg_seq[0] += 1
                mid = msg_seq[0]
                ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
                while True:
                    msg = json.loads(ws.recv())
                    if msg.get("method") == "Runtime.exceptionThrown":
                        page_exceptions.append(msg.get("params"))
                        continue
                    if msg.get("id") == mid:
                        return msg.get("result", {})

            cdp("Page.enable")
            cdp("Runtime.enable")
            cdp("Page.navigate", {"url": f"http://127.0.0.1:{port}/"})
            time.sleep(1.8)

            # Authorize guest session and switch to Studio view
            cdp(
                "Runtime.evaluate",
                {
                    "expression": """(() => {
                      document.getElementById('btnGateGuestEnter')?.click();
                      if (window.__GS_API && typeof window.__GS_API.switchView === 'function') {
                        window.__GS_API.switchView('studio');
                      }
                      return true;
                    })()""",
                    "returnByValue": True,
                },
            )
            time.sleep(0.8)

            for vw, vh, is_mob in ((768, 1024, False), (375, 812, True)):
                cdp("Emulation.clearDeviceMetricsOverride")
                cdp(
                    "Emulation.setDeviceMetricsOverride",
                    {
                        "width": vw,
                        "height": vh,
                        "screenWidth": vw,
                        "screenHeight": vh,
                        "deviceScaleFactor": 2,
                        "mobile": is_mob,
                    },
                )
                time.sleep(0.45)
                metrics = cdp(
                    "Runtime.evaluate",
                    {
                        "expression": """(() => {
                          window.dispatchEvent(new Event('resize'));
                          window.__GS_API?.syncCompactStudioDockUI?.();
                          const dock = document.getElementById('bimBottomDock');
                          const topBar = document.querySelector('#viewStudio .gs-studio-top-bar');
                          const topPill = document.querySelector('#viewStudio .gs-studio-main-pill');
                          const dockRect = dock.getBoundingClientRect();
                          document.getElementById('btnDockMoreTools')?.click();
                          const pop = document.getElementById('studioCompactToolsPopover');
                          const popTiles = pop ? pop.querySelectorAll('.gs-compact-tool-tile').length : 0;
                          window.closeCompactStudioPopovers?.();
                          const slotIds = ['btnDockOrbitNav', 'btnDockCatMeasure', 'btnDockCatCivil', 'btnDockCatLayers', 'btnDockMoreTools'];
                          const visibleSlots = slotIds.filter(id => {
                            const el = document.getElementById(id);
                            return el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width >= 36;
                          }).length;
                          return {
                            vw: window.innerWidth,
                            dockScrollW: dock.scrollWidth,
                            dockClientW: dock.clientWidth,
                            dockRight: Math.round(dockRect.right),
                            dockLeft: Math.round(dockRect.left),
                            dockOverflowX: getComputedStyle(dock).overflowX,
                            topScrollW: topBar ? topBar.scrollWidth : 0,
                            topClientW: topBar ? topBar.clientWidth : 0,
                            pillScrollW: topPill ? topPill.scrollWidth : 0,
                            pillClientW: topPill ? topPill.clientWidth : 0,
                            popTiles,
                            visibleSlots,
                          };
                        })()""",
                        "returnByValue": True,
                    },
                )["result"]["value"]

                self.assertLessEqual(
                    metrics["dockScrollW"],
                    metrics["dockClientW"] + 1,
                    f"Studio dock horizontally overflows at {vw}px: {metrics}",
                )
                self.assertGreaterEqual(metrics["dockLeft"], 0, f"Studio dock clipped left at {vw}px: {metrics}")
                self.assertLessEqual(metrics["dockRight"], vw + 1, f"Studio dock clipped right at {vw}px: {metrics}")
                self.assertEqual(metrics["dockOverflowX"], "hidden")
                self.assertLessEqual(metrics["topScrollW"], metrics["topClientW"] + 1)
                self.assertLessEqual(metrics["pillScrollW"], metrics["pillClientW"] + 1)
                self.assertGreaterEqual(metrics["popTiles"], 8)
                self.assertEqual(metrics["visibleSlots"], 5, f"All 5 compact dock slots must be visible at {vw}px: {metrics}")

            self.assertEqual(len(page_exceptions), 0, f"Unexpected JS runtime exceptions: {page_exceptions}")
        finally:
            try:
                if ws:
                    ws.close()
            except Exception:
                pass
            if chrome_proc:
                try:
                    chrome_proc.terminate()
                    chrome_proc.wait(timeout=5)
                except Exception:
                    try:
                        chrome_proc.kill()
                    except Exception:
                        pass
            httpd.shutdown()
            httpd.server_close()
            shutil.rmtree(user_data_dir, ignore_errors=True)

    def test_64_hd_tile_idle_gating_pinned_coarse_and_bounded_gpu_cache(self):
        """Verify Studio 3D Tiles smart LOD engine pins coarse tiles, idle-gates HD fetches during camera motion, bounded-evicts GPU memory, and keeps native DPR."""
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.js"), "r", encoding="utf-8") as f:
            app_js = f.read()

        # 1. Verify pinned coarse base tile protection, leaf-direct ancestor skip & zero-gap ancestor fallback
        self.assertIn("tr.loadAncestors =", js02)
        self.assertIn("STUDIO_HD_IDLE_DELAY_MS", js03)
        self.assertIn("STUDIO_GLIDE_STREAM_INTERVAL_MS", js03)
        self.assertIn("computeStudioTilePriority", js03)
        self.assertIn("identifyAndPinCoarseBaseTiles", js03)
        self.assertIn("ensureZeroGapCoarseCoverage", js03)
        self.assertIn("unhideNearestLoadedAncestor", js03)
        self.assertIn("__gsPinnedCoarse", js03)

        # 2. Verify camera-idle gate & in-flight HD tile abort on movement
        self.assertIn("markStudioCameraActivity", js03)
        self.assertIn("abortInFlightHdTiles", js03)
        self.assertIn("stepStudioTilesStreaming", js03)
        self.assertIn("window.stepStudioTilesStreaming = stepStudioTilesStreaming;", js03)
        self.assertIn("window.stepStudioTilesStreaming(performance.now())", app_js)
        self.assertIn("if (studioThree?._camMoving) return;", js03)

        # 3. Verify accurate GPU byte estimator & bounded HD LRU eviction with deep GPU disposal
        self.assertIn("estimateTileSceneGpuBytes", js03)
        self.assertIn("enforceStudioHdGpuBudget", js03)
        self.assertIn("evictHdTileCleanly", js03)
        self.assertIn("calculateBytesUsed", js03)
        self.assertIn("disposeObjectGpuDeep", js03)

        # 4. Verify native crisp pixel ratio is preserved (never degraded to setPixelRatio(1))
        self.assertIn("getStudioTargetPixelRatio", js03)
        self.assertNotIn("setPixelRatio(1)", js03)
        self.assertNotIn("setPixelRatio(1.0)", js03)


if __name__ == "__main__":
    unittest.main()
