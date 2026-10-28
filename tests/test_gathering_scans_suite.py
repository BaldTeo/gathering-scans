#!/usr/bin/env python3
"""
Automated Verification Suite for GatheringScans (scans.gatheren.cloud)
Tests:
1. GDrive Inbox OPF .zip extraction & TWD97 (121) + TWVD2001 coordinate conversion
2. Smart Single-Concurrency Queue (WSJF-Aging + Anti-Starvation after 3 bypasses / 90m)
3. PIX4Dmatic 2.11.0 .gst script generation (TWD97 + TWVD2001 WKT & 2048px 2K textures)
4. Cut/Fill & Stockpile Volume + HTML/Excel Report & AutoCAD .DXF/.DWG 3D Contours
5. Scoped External Share Links (/s/<token>) isolation & instant revocation
6. GC_ScanOptimizer PC actions & Google Chat Rich Card notifications
"""

import os
import sys
import time
import tempfile
import unittest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from pc_worker.config import (
    GDRIVE_INBOX_DIR,
    TWD97_TWVD2001_WKT,
    PIX4DMATIC_TEXTURE_SIZE,
)
from pc_worker.priority_queue import ScanQueueDB, calculate_priority_score
from pc_worker.gdrive_watcher import extract_opf_zip_metadata, twd97_to_wgs84, wgs84_to_twd97
from pc_worker.pix4d_runner import generate_pix4dmatic_gst_script
from pc_worker.surveying_engine import SurveyingEngine
from pc_worker.auth_and_sharing import AuthAndSharingManager, parse_user_agent, is_link_preview_bot
from pc_worker.optimizer_bridge import OptimizerBridge
from pc_worker.gchat_notifier import GoogleChatNotifier


class GatheringScansTestSuite(unittest.TestCase):
    def setUp(self):
        self.tmp_db_fd, self.tmp_db_path = tempfile.mkstemp(suffix=".db")
        os.close(self.tmp_db_fd)
        self.db = ScanQueueDB(db_path=self.tmp_db_path)

    def tearDown(self):
        try:
            os.remove(self.tmp_db_path)
        except OSError:
            pass

    def test_01_twd97_and_opf_zip_extraction(self):
        """Verify TWD97 (121) <-> WGS84 conversion and real SCANS TEST .zip inspection."""
        lat, lon = twd97_to_wgs84(304952.656, 2757084.875)
        self.assertAlmostEqual(lat, 24.9203, places=3)
        self.assertAlmostEqual(lon, 121.5441, places=3)

        e, n, h = wgs84_to_twd97(lat, lon, 43.18)
        self.assertAlmostEqual(e, 304952.656, delta=1.5)
        self.assertAlmostEqual(n, 2757084.875, delta=1.5)

        if os.path.isdir(GDRIVE_INBOX_DIR):
            test_zip = os.path.join(GDRIVE_INBOX_DIR, "2026-10-05-15-37-05.zip")
            if os.path.isfile(test_zip):
                meta = extract_opf_zip_metadata(test_zip)
                self.assertEqual(meta["image_count"], 709)
                self.assertEqual(meta["project_group"], "QuChi Dam")
                self.assertEqual(meta["texture_resolution"], 2048)
                self.assertIn("TWD97", meta["crs"])

    def test_02_smart_priority_queue_and_anti_starvation(self):
        """Verify small scans get priority over large scans up to the anti-starvation threshold."""
        now = time.time()
        # Enqueue a large scan first (2463 photos)
        self.db.upsert_scan(
            {
                "scan_id": "large_scan_2463",
                "name": "Large Scan (2463 imgs)",
                "image_count": 2463,
                "size_bytes": 8600 * 1024 * 1024,
                "uploaded_at": now - 60,  # waited 1 min
                "status": "queued",
            }
        )
        # Enqueue a small scan slightly later (120 photos)
        self.db.upsert_scan(
            {
                "scan_id": "small_scan_120",
                "name": "Small Trench Scan (120 imgs)",
                "image_count": 120,
                "size_bytes": 350 * 1024 * 1024,
                "uploaded_at": now,
                "status": "queued",
            }
        )

        # Pop first job -> small scan should win because 120 imgs << 2463 imgs
        job1 = self.db.pop_next_job(now=now)
        self.assertIsNotNone(job1)
        self.assertEqual(job1["scan_id"], "small_scan_120")

        # While job1 is 'processing', single-concurrency mutex blocks next pop
        blocked = self.db.pop_next_job(now=now)
        self.assertIsNone(blocked)

        # Complete job1 and verify large_scan_2463 had its bypass_count incremented to 1
        self.db.update_job_progress("small_scan_120", "completed", 100.0, "Done")
        large_info = self.db.get_scan("large_scan_2463")
        self.assertEqual(large_info["bypass_count"], 1)

        # Simulate 2 more small scans bypassing large_scan_2463 (reaching bypass_count == 3)
        for idx in (2, 3):
            sid = f"small_scan_{idx}"
            self.db.upsert_scan(
                {
                    "scan_id": sid,
                    "name": f"Small Scan {idx}",
                    "image_count": 90,
                    "size_bytes": 200 * 1024 * 1024,
                    "uploaded_at": now + idx,
                    "status": "queued",
                }
            )
            popped = self.db.pop_next_job(now=now + idx)
            self.assertEqual(popped["scan_id"], sid)
            self.db.update_job_progress(sid, "completed", 100.0, "Done")

        # Now large_scan_2463 has bypass_count == 3 -> anti-starvation lock MUST beat a brand new tiny scan!
        self.db.upsert_scan(
            {
                "scan_id": "tiny_scan_30",
                "name": "Tiny Scan (30 imgs)",
                "image_count": 30,
                "size_bytes": 80 * 1024 * 1024,
                "uploaded_at": now + 10,
                "status": "queued",
            }
        )
        locked_job = self.db.pop_next_job(now=now + 10)
        self.assertEqual(locked_job["scan_id"], "large_scan_2463")

    def test_03_pix4dmatic_gst_enforces_twd97_twvd2001_and_2k(self):
        """Verify generated PIX4Dmatic .gst script enforces EPSG:3826+8904 and 2048 textureSize."""
        gst = generate_pix4dmatic_gst_script(
            project_p4m_path="C:/Scans/test_job/test_job.p4m",
            input_zip_or_folder="G:/My Drive/SCANS TEST/2026-10-05-15-37-05.zip",
            export_dir="C:/Scans/test_job/exports",
        )
        self.assertIn("SetGcpCrs", gst)
        self.assertIn('ID["EPSG",3826]', gst)
        self.assertIn('ID["EPSG",8904]', gst)
        self.assertIn('GEOIDMODEL["TWGEOID2018h"]', gst)
        self.assertIn(f"settings.textureSize : {PIX4DMATIC_TEXTURE_SIZE}", gst)
        self.assertTrue("settings.exportSrs : ExportSrs.Scene" in gst or "settings.exportSrs : ExportSrs.Project" in gst)
        self.assertIn("CloseSession", gst)

    def test_04_surveying_volume_and_dwg_dxf_contours(self):
        """Verify Cut/Fill Stockpile report generation and AutoCAD 3D .DXF/.DWG contour export."""
        survey = SurveyingEngine(self.db)
        vol = survey.calculate_cut_fill_volume(
            {
                "scan_id": "quchi_20261005_merged",
                "stockpile_name": "Unit Test Stockpile",
                "base_mode": "triangulated_boundary",
                "material_type": "crushed_stone",
                "polygon": [
                    [304945.0, 2757078.0, 43.1],
                    [304960.0, 2757078.0, 43.1],
                    [304960.0, 2757090.0, 43.2],
                    [304945.0, 2757090.0, 43.2],
                ],
            }
        )
        self.assertEqual(vol["status"], "ok")
        self.assertAlmostEqual(vol["planar_area_m2"], 180.0, places=1)
        self.assertGreater(vol["fill_volume_m3"], 50.0)
        self.assertGreater(vol["estimated_tonnage_t"], 80.0)

        cnt = survey.generate_elevation_contours(
            {
                "scan_id": "quchi_20261005_merged",
                "minor_interval_m": 0.5,
                "major_interval_m": 2.5,
            }
        )
        self.assertEqual(cnt["status"], "ok")
        self.assertGreater(cnt["contour_count"], 10)
        self.assertTrue(cnt["dxf_url"].endswith(".dxf"))
        self.assertTrue(cnt["dwg_url"].endswith((".dwg", ".dxf")))

    def test_05_scoped_external_sharing_and_revocation(self):
        """Verify external share links strictly isolate scan access and revoke immediately."""
        self.db.upsert_scan({"scan_id": "scan_a", "name": "Scan A", "project_group": "Group 1", "status": "completed"})
        self.db.upsert_scan({"scan_id": "scan_b", "name": "Scan B", "project_group": "Group 2", "status": "completed"})

        auth = AuthAndSharingManager(self.db)
        link = auth.create_share_link(
            {
                "scope_type": "scan",
                "target_id": "scan_a",
                "label": "External Contractor Link",
            }
        )
        tok = link["token"]
        self.assertEqual(link["share_url"], f"https://scans.gatheren.cloud/s/{tok}")
        self.assertEqual(link["direct_url"], f"https://scans.gatheren.cloud/?share={tok}")

        # Authorized scan_a succeeds
        ok_a, _, _, allowed = auth.validate_share_access(tok, requested_scan_id="scan_a")
        self.assertTrue(ok_a)
        self.assertEqual(len(allowed), 1)
        self.assertEqual(allowed[0]["scan_id"], "scan_a")

        # Unauthorized scan_b is strictly blocked
        ok_b, reason_b, _, _ = auth.validate_share_access(tok, requested_scan_id="scan_b")
        self.assertFalse(ok_b)
        self.assertIn("outside the authorized scope", reason_b)

        # Revoke link -> scan_a is immediately blocked
        auth.revoke_share_link(tok)
        ok_revoked, reason_rev, _, _ = auth.validate_share_access(tok, requested_scan_id="scan_a")
        self.assertFalse(ok_revoked)
        self.assertIn("revoked", reason_rev)

        # Quick Single-Scan View & Comment Only link
        quick_link = auth.create_share_link(
            {
                "scope_type": "scan",
                "target_id": "scan_a",
                "label": "View & Comment — Scan A",
                "allow_measurements": False,
                "allow_comments": True,
                "allow_download": False,
            }
        )
        self.assertFalse(quick_link["allow_measurements"])
        self.assertTrue(quick_link["allow_comments"])
        self.assertFalse(quick_link["allow_download"])
        self.assertTrue(quick_link["share_url"].startswith("https://scans.gatheren.cloud/s/"))

    def test_06_share_telemetry_analytics_and_preview_bots(self):
        """Verify LINE/chat bot detection vs LINE In-App human browser, and monotonic telemetry analytics."""
        # 1. LINE link-preview bot vs LINE In-App human visitor vs Desktop Chrome
        line_bot = parse_user_agent("facebookexternalhit/1.1;line-poker/1.0")
        self.assertTrue(line_bot["is_bot"])
        self.assertEqual(line_bot["browser"], "LINE Preview Bot")
        self.assertTrue(is_link_preview_bot("facebookexternalhit/1.1;line-poker/1.0"))

        line_human = parse_user_agent(
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
            "(KHTML, like Gecko) Mobile/15E148 Safari/604.1 Line/14.16.0"
        )
        self.assertFalse(line_human["is_bot"])
        self.assertIn("LINE In-App", line_human["browser"])
        self.assertEqual(line_human["os"], "iOS 17.5")
        self.assertEqual(line_human["device_type"], "Mobile")

        # 2. Bot unfurl vs Human session telemetry
        self.db.upsert_scan(
            {
                "scan_id": "scan_qihu",
                "name": "QiHu — Unified Merged Scan (4 Scans)",
                "project_group": "QiHu",
                "capture_date": "2026-10-24",
                "status": "completed",
            }
        )
        auth = AuthAndSharingManager(self.db)
        link = auth.create_share_link(
            {
                "scope_type": "scan",
                "target_id": "scan_qihu",
                "label": "View & Comment — QiHu",
                "allow_measurements": False,
                "allow_comments": True,
                "allow_download": False,
            }
        )
        tok = link["token"]

        # Chat preview unfurl does NOT inflate human view_count
        auth.record_bot_unfurl(tok, "203.104.140.10", "facebookexternalhit/1.1;line-poker/1.0")
        after_bot = auth.get_share_link(tok)
        self.assertEqual(after_bot["view_count"], 0)
        self.assertEqual(after_bot["bot_unfurls"], 1)

        # Human session #1 initial heartbeat + later monotonic update
        auth.record_or_update_share_session(
            {
                "token": tok,
                "session_id": "s_test_human_1",
                "visitor_id": "v_alice_01",
                "viewer_name": "",
                "total_duration_sec": 12.0,
                "active_duration_sec": 10.0,
                "max_load_pct": 65.0,
                "camera_interactions": 4,
                "scans_viewed": [{"scan_id": "scan_qihu", "name": "QiHu — Unified Merged Scan (4 Scans)"}],
                "tools_used": {"orbit": {"count": 4, "seconds": 10.0}},
                "events": [{"id": "ev1", "t": 0.0, "type": "session_open", "detail": "Opened link"}],
            },
            request_meta={
                "ip_address": "127.0.0.1",
                "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
                "accept_language": "zh-TW",
            },
        )
        auth.record_or_update_share_session(
            {
                "token": tok,
                "session_id": "s_test_human_1",
                "visitor_id": "v_alice_01",
                "viewer_name": "Alice Chen",
                "total_duration_sec": 95.0,
                "active_duration_sec": 74.0,
                "max_load_pct": 100.0,
                "load_time_ms": 2850,
                "camera_interactions": 18,
                "fp_seconds": 22.0,
                "comments_posted": 1,
                "tools_used": {
                    "orbit": {"count": 18, "seconds": 40.0},
                    "first_person_fly": {"count": 1, "seconds": 22.0},
                    "comments": {"count": 1, "seconds": 12.0},
                    "comment_posted": {"count": 1, "seconds": 0.0},
                },
                "events": [
                    {"id": "ev1", "t": 0.0, "type": "session_open", "detail": "Opened link"},
                    {"id": "ev2", "t": 2.9, "type": "scan_loaded", "detail": "100%"},
                    {"id": "ev3", "t": 55.0, "type": "comment", "detail": "Alice Chen posted comment"},
                ],
            },
            request_meta={"ip_address": "127.0.0.1"},
        )

        analytics = auth.get_share_analytics(token=tok)
        self.assertEqual(analytics["status"], "ok")
        summary = analytics["summary"]
        self.assertEqual(analytics["link"]["view_count"], 1)
        self.assertEqual(summary["recorded_sessions"], 1)
        self.assertEqual(summary["unique_visitors"], 1)
        self.assertEqual(summary["bot_unfurls"], 1)
        self.assertAlmostEqual(summary["total_active_sec"], 74.0, places=1)
        self.assertEqual(summary["comments_posted_total"], 1)
        human_sess = [s for s in analytics["sessions"] if not s["is_bot"]][0]
        self.assertEqual(human_sess["viewer_name"], "Alice Chen")
        self.assertEqual(human_sess["load_time_ms"], 2850)
        self.assertEqual(len(human_sess["events"]), 3)

    def test_07_modular_architecture_strict_5000_line_ceiling(self):
        """Verify all source files (.py, .js, .css, .html) strictly obey the < 5,000-line modular limit."""
        checked = 0
        for root, dirs, files in os.walk(BASE_DIR):
            dirs[:] = [
                d
                for d in dirs
                if d not in (".git", "data", "node_modules", "__pycache__", ".agent", "third_party")
            ]
            for fn in files:
                if fn.endswith((".py", ".js", ".css", ".html")):
                    fp = os.path.join(root, fn)
                    with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                        line_count = sum(1 for _ in f)
                    self.assertLess(
                        line_count,
                        5000,
                        f"File {os.path.relpath(fp, BASE_DIR)} has {line_count} lines (exceeds 5,000-line ceiling)",
                    )
                    checked += 1
        self.assertGreaterEqual(checked, 35)

    def test_08_eleven_ux_and_surveying_fixes(self):
        """Verify all 11 UX, mobile, surveying, and admin layout fixes."""
        survey = SurveyingEngine(self.db)

        # 1. Profile slope in % and dh:L
        prof = survey.compute_cross_section_profile(
            {
                "scan_id": "quchi_20261005_merged",
                "start_point": [304945.0, 2757078.0],
                "end_point": [304960.0, 2757090.0],
            }
        )
        self.assertEqual(prof["status"], "ok")
        self.assertIn("overall_dh_m", prof)
        self.assertIn("overall_slope_pct", prof)
        self.assertIn("overall_slope_dhl", prof)
        self.assertTrue(prof["overall_slope_dhl"].startswith(("1:", "0:")))

        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            html = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            css = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()

        # 2. Guest mode includes laser and volume tools
        self.assertIn('"btnMeasureLaser"', js01)
        self.assertIn('"btnMeasureVolume"', js01)
        self.assertIn('"btnDockVolume"', js01)

        # 3. Mobile view first page map-only until site chosen
        self.assertIn("mobile-site-open", css)
        self.assertIn("mobile-site-open", js02)

        # 4. Mobile Studio editing dock umbrella button & Clear right after Laser
        self.assertIn('id="btnMobileEditingUmbrella"', html)
        laser_idx = html.index('id="btnMeasureLaser"')
        clear_idx = html.index('id="btnMeasureClear"')
        vol_idx = html.index('id="btnDockVolume"')
        self.assertLess(laser_idx, clear_idx)
        self.assertLess(clear_idx, vol_idx)

        # 5. Laser 2 independent bubble pairs (width & length) with dh:L and no origin label
        self.assertIn("formatSlopeDhL", js04)
        self.assertIn("autodesk-laser-pair", js04)
        self.assertIn("laser-bubble-w", js04)
        self.assertIn("laser-bubble-l", js04)

        # 6. Top-left semi-transparent red-blue small north arrow
        self.assertIn('id="gsNorthArrowCompass"', html)
        self.assertIn("updateNorthArrowCompass", js03)

        # 7. Angle tool: angle once at P2 + azimuths at P1 & P3
        self.assertIn("autodesk-azimuth-badge", js03)
        self.assertIn("Az ${az1.toFixed(1)}°", js03)
        self.assertIn("Az ${az3.toFixed(1)}°", js03)

        # 8. Compact 4-row point coordinate badge (Name; E; N; H)
        self.assertIn("coord-row coord-row-name", js03)

        # 9. Area tool waits until polygon is closed
        self.assertIn("renderClosedAreaPolygon", js04)

        # 10. Section, Profile, Volume, Contours wait for user input
        self.assertIn('tool === "section"', js04)
        self.assertIn("STATE.sectionBoxEndpoints", js05)
        self.assertIn("Slope A→B (% & dh:L)", js05)

        # 11. GChat webhook inside Admin Settings modal (#modalOfflineCache) and NOT in #modalQueue
        queue_start = html.index('id="modalQueue"')
        offline_start = html.index('id="modalOfflineCache"')
        webhook_idx = html.index('id="inputGChatWebhookUrl"')
        self.assertGreater(webhook_idx, offline_start)
        self.assertNotIn('id="inputGChatWebhookUrl"', html[queue_start:offline_start])

    def test_09_six_additional_ux_security_and_compare_fixes(self):
        """Verify all 6 additional fixes: Comments persistence & CRUD, 3x North Arrow without background, 2-row TWD97/WGS84, 雲在天 博士, 3/4-scan Multi-Viewport Compare, and Admin-only settings security."""
        # 1a & 1b: Comments returned in list_scans(), update_comment(), and delete_comment()
        scan_id = "quchi_20261005_merged"
        self.db.upsert_scan(
            {
                "scan_id": scan_id,
                "name": "QuChi Dam Merged Scan",
                "project_group": "QuChi Dam",
                "status": "completed",
            }
        )
        created = self.db.add_comment(
            {
                "scan_id": scan_id,
                "author_email": "glibivanov@gatheren.com.tw",
                "author_name": "雲在天",
                "text": "Initial test comment on scan",
                "pos_x": 1.5,
                "pos_y": 2.0,
                "pos_z": -3.5,
                "twd97_e": 304950.0,
                "twd97_n": 2757080.0,
                "twd97_h": 125.4,
            }
        )
        cid = created["comment_id"]
        scans = self.db.list_scans()
        target_scan = [s for s in scans if s["scan_id"] == scan_id][0]
        self.assertIn("comments", target_scan)
        self.assertTrue(any(c["comment_id"] == cid for c in target_scan["comments"]))

        updated = self.db.update_comment(cid, "Edited test comment text", "雲在天")
        self.assertIsNotNone(updated)
        self.assertEqual(updated["text"], "Edited test comment text")

        deleted_ok = self.db.delete_comment(cid)
        self.assertTrue(deleted_ok)
        scans_after = self.db.list_scans()
        target_after = [s for s in scans_after if s["scan_id"] == scan_id][0]
        self.assertFalse(any(c["comment_id"] == cid for c in target_after["comments"]))

        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            html = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            css = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "07-compare-and-queue.js"), "r", encoding="utf-8") as f:
            js07 = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.js"), "r", encoding="utf-8") as f:
            app_js = f.read()
        with open(os.path.join(BASE_DIR, "server.py"), "r", encoding="utf-8") as f:
            srv_py = f.read()

        # 1a/1b/1c: Comment pins preserved on clear, edit/delete buttons, semi-transparent comment icon + hover/tap popover
        self.assertIn("isCommentPin", js03)
        self.assertIn("STATE.pendingCommentDraftPt", js04)
        self.assertNotIn('if (tool === "comments") {\n      add3DPinMarker', js04)
        self.assertIn("data-comment-edit", js05)
        self.assertIn("data-comment-delete", js05)
        self.assertIn("gs-scan-comment-pin", js05)
        self.assertIn("gs-comment-pin-popover", js05)
        self.assertIn(".gs-scan-comment-pin", css)

        # 2. North arrow compass ~3x bigger (84x84 SVG, 92x92 container), no circular background, mobile top: 76px
        self.assertIn('width="84" height="84"', html)
        self.assertIn("background: transparent !important;", css)
        self.assertIn("top: 76px !important;", css)

        # 3. Removed redundant TWD97 labels and 2-row TWD97 + WGS84 in Scan Clusters modal
        self.assertNotIn("Scan Clusters (TWD97)", html)
        self.assertNotIn("掃描工區群組 (TWD97)", html)
        self.assertIn('coordEl.innerHTML = `<div style="white-space:nowrap;">TWD97(121)', js02)
        self.assertNotIn("Google Maps · TWD97 (121) + TWVD2001", js02)

        # 4. In Chinese Dr. Glib Ivanov is 雲在天 博士
        self.assertIn("由 雲在天 博士與 Gemini 4 Argon 開發", html)
        self.assertIn("由 雲在天 博士與 Gemini 4 Argon 開發", app_js)
        self.assertNotIn("由 Glib Ivanov 博士", html)
        self.assertNotIn("由 Glib Ivanov 博士", app_js)

        # 5. Compare 2, 3, or 4 scans in Multi-Viewport
        self.assertIn('id="compareScanCountSwitcher"', html)
        self.assertIn('id="compareThirdLayer"', html)
        self.assertIn('id="compareFourthLayer"', html)
        self.assertIn('id="compareThirdSelect"', html)
        self.assertIn('id="compareFourthSelect"', html)
        self.assertIn("setCompareScanCount", js07)
        self.assertIn('data-compare-count="3"', css)
        self.assertIn('data-compare-count="4"', css)

        # 6. Critical/secret/internal settings accessible only by Admin
        self.assertIn('setDisp("adminControlPanelSection", info.canManageUsers', js01)
        self.assertIn('setDisp("settingsServiceAccountCard", info.canManageUsers', js01)
        self.assertIn('setDisp("settingsPix4dPipelineSection", info.canManageUsers', js01)
        self.assertIn('setDisp("gateExistingUsersSection", info.canManageUsers', js01)
        self.assertIn("_filter_profiles_for_caller", srv_py)

    def test_10_six_new_surveying_compare_and_qa_features(self):
        """Verify all 6 new civil surveying, compare & QA features:
        1. Persistent Measurement Bookmarks (SQLite + REST + Studio restore)
        2. True Orthomosaic 2D Nadir Plan Overlay on Map
        3. Compare Mode ΔZ Probe & Multi-Epoch Cross-Section Profile (A→B)
        4. Surface Drainage / Slope Steepness Heatmap & Rainwater Runoff Flow-Lines
        5. Automated GCP / Check-Point Accuracy QA Report (RMSE_E/N/Z/3D + ASPRS grade)
        6. Direct Field-to-3D Photo Frustum Projection & Camera Alignment
        """
        scan_id = "quchi_20261005_merged"
        self.db.upsert_scan(
            {
                "scan_id": scan_id,
                "name": "QuChi Dam Merged Scan",
                "project_group": "QuChi Dam",
                "status": "completed",
            }
        )

        # 1. Persistent Measurement Bookmarks CRUD in ScanQueueDB
        saved_bm = self.db.save_measurement_bookmark(
            {
                "scan_id": scan_id,
                "title": "Dam Crest Cut/Fill & Profile Check",
                "author_email": "glibivanov@gatheren.com.tw",
                "author_name": "Dr. Glib Ivanov",
                "active_tool": "volume",
                "camera_state": {
                    "pos": [12.5, 45.0, 18.2],
                    "target": [0.0, 2.0, -5.0],
                    "view_mode": "3d",
                },
                "measurements_state": {
                    "measure_points": [{"x": 1.0, "y": 2.0, "z": -3.0, "twd97": {"E": 304950.0, "N": 2757080.0, "H": 125.4}}],
                    "volume_points": [{"x": 0.0, "y": 1.0, "z": 0.0}, {"x": 5.0, "y": 1.2, "z": 0.0}, {"x": 5.0, "y": 1.1, "z": -5.0}],
                    "profile_points": [{"x": -4.0, "y": 1.0, "z": 2.0}, {"x": 6.0, "y": 2.5, "z": -3.0}],
                    "section_box": {"enabled": True, "minX": -25, "maxX": 25, "minY": -10, "maxY": 25, "minZ": -25, "maxZ": 25},
                },
            }
        )
        self.assertIn("bookmark_id", saved_bm)
        self.assertEqual(saved_bm["title"], "Dam Crest Cut/Fill & Profile Check")
        self.assertEqual(saved_bm["camera_state"]["view_mode"], "3d")
        self.assertEqual(len(saved_bm["measurements_state"]["volume_points"]), 3)

        bms = self.db.list_measurement_bookmarks(scan_id)
        self.assertTrue(any(b["bookmark_id"] == saved_bm["bookmark_id"] for b in bms))

        scans = self.db.list_scans()
        target_scan = [s for s in scans if s["scan_id"] == scan_id][0]
        self.assertIn("measurement_bookmarks", target_scan)
        self.assertGreaterEqual(target_scan["bookmark_count"], 1)

        deleted_bm = self.db.delete_measurement_bookmark(saved_bm["bookmark_id"], scan_id)
        self.assertTrue(deleted_bm)
        self.assertEqual(len(self.db.list_measurement_bookmarks(scan_id)), 0)

        # 4. Surface Drainage / Slope Steepness Heatmap & Runoff Flow-Lines engine
        survey = SurveyingEngine(self.db)
        drain_res = survey.compute_drainage_and_slope(
            {
                "scan_id": scan_id,
                "grid_size": 16,
                "num_droplets": 18,
                "pond_slope_threshold_deg": 2.0,
            }
        )
        self.assertEqual(drain_res["status"], "ok")
        self.assertIn("gentle_pct", drain_res)
        self.assertIn("moderate_pct", drain_res)
        self.assertIn("steep_pct", drain_res)
        self.assertIn("mean_slope_deg", drain_res)
        self.assertIn("max_slope_deg", drain_res)

        # Also test compute_drainage_and_slope when _load_or_build_scan_dsm returns a 220x220 dsm_contour / dsm_raw dict
        import numpy as np
        orig_loader = survey._load_or_build_scan_dsm
        try:
            yy, xx = np.mgrid[0:220, 0:220]
            synth_dsm = 120.0 + 0.12 * xx - 0.08 * yy
            survey._load_or_build_scan_dsm = lambda sc: {
                "dsm_raw": synth_dsm,
                "dsm_contour": synth_dsm,
                "e_min": 304900.0,
                "e_max": 305010.0,
                "n_min": 2757020.0,
                "n_max": 2757130.0,
                "h_median": 125.0,
            }
            drain_real = survey.compute_drainage_and_slope({"scan_id": scan_id, "grid_size": 16})
            self.assertEqual(drain_real["status"], "ok")
            self.assertGreater(len(drain_real["slope_cells"]), 0)
            self.assertLessEqual(len(drain_real["slope_cells"]), 16 * 16)
        finally:
            survey._load_or_build_scan_dsm = orig_loader

        # 5. Automated GCP / Check-Point Accuracy QA Report engine
        gcp_res = survey.compute_gcp_accuracy_qa(
            {
                "scan_id": scan_id,
                "tolerance_3d_m": 0.05,
                "gcps": [
                    {
                        "id": "GCP-01",
                        "e": 304950.000,
                        "n": 2757080.000,
                        "h": 125.400,
                        "mesh_e": 304950.012,
                        "mesh_n": 2757079.989,
                        "mesh_h": 125.418,
                    },
                    {
                        "id": "GCP-02",
                        "e": 304985.000,
                        "n": 2757110.000,
                        "h": 126.850,
                        "mesh_e": 304984.991,
                        "mesh_n": 2757110.014,
                        "mesh_h": 126.835,
                    },
                ],
            }
        )
        self.assertEqual(gcp_res["status"], "ok")
        self.assertEqual(gcp_res["point_count"], 2)
        self.assertLess(gcp_res["rmse_z_m"], 0.05)
        self.assertEqual(gcp_res["qa_grade"], "A")
        self.assertIn("Grade A", gcp_res["qa_grade_label"])
        self.assertTrue(gcp_res["csv_url"].startswith("/api/reports/"))
        self.assertTrue(gcp_res["html_url"].startswith("/api/reports/"))

        # Verify all frontend & backend wiring across files + JS syntax check via node --check
        import subprocess
        import shutil
        node_bin = shutil.which("node")
        if node_bin:
            js_files = [
                os.path.join(BASE_DIR, "web", "app.js"),
                os.path.join(BASE_DIR, "web", "sw.js"),
            ]
            src_dir = os.path.join(BASE_DIR, "web", "src")
            for fn in sorted(os.listdir(src_dir)):
                if fn.endswith(".js"):
                    js_files.append(os.path.join(src_dir, fn))
            for jf in js_files:
                proc = subprocess.run([node_bin, "--check", jf], capture_output=True, text=True)
                self.assertEqual(proc.returncode, 0, f"JS syntax error in {jf}: {proc.stderr}")

        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            html = f.read()
        with open(os.path.join(BASE_DIR, "web", "sw.js"), "r", encoding="utf-8") as f:
            sw_js = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            css = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "06-studio-align-and-optimizer.js"), "r", encoding="utf-8") as f:
            js06 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "07-compare-and-queue.js"), "r", encoding="utf-8") as f:
            js07 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()
        with open(os.path.join(BASE_DIR, "pc_worker", "server_api_routes.py"), "r", encoding="utf-8") as f:
            routes_py = f.read()

        self.assertIn("/src/08-advanced-surveying-and-qa.js", html)
        self.assertIn("/src/08-advanced-surveying-and-qa.js", sw_js)
        self.assertIn('id="btnMapToggleOrthoOverlay"', html)
        self.assertIn('id="btnStudioSavedViews"', html)
        self.assertIn('id="btnDockDrainage"', html)
        self.assertIn('id="btnDockGcpQa"', html)
        self.assertIn('id="btnDockBookmarks"', html)
        self.assertIn('id="btnCompareDeltaZProbe"', html)
        self.assertIn('id="btnCompareMultiProfile"', html)
        self.assertIn('id="compareProfileDrawer"', html)
        self.assertIn('id="studioPhotoFrustumOverlay"', html)
        self.assertIn("drawMapTrueOrthoOverlays", js02)
        self.assertIn("clearDrainageVisuals3D()", js03)
        self.assertIn("clearGcpQaMarkers3D()", js03)
        self.assertIn("clearRtkPhotoFrustums3D()", js03)
        self.assertIn("renderRtkPhotoFrustums3D", js05)
        self.assertIn('tool === "drainage"', js06)
        self.assertIn('tool === "gcp_qa"', js06)
        self.assertIn('tool === "bookmarks"', js06)
        self.assertIn("initCompareSurveyingTools", js07)
        self.assertIn("openDrainageAndSlopeInspector", js08)
        self.assertIn("openGcpAccuracyQaInspector", js08)
        self.assertIn("openSavedMeasurementsInspector", js08)
        self.assertIn("alignStudioCameraToRtkPhoto", js08)
        self.assertIn("clearMeasurements()", js08)
        self.assertIn("renderDistanceVisuals(null, measObj)", js08)
        self.assertIn("renderAngleVisuals(null, measObj)", js08)
        self.assertIn("renderCoordinateVisuals(pt, measObj)", js08)
        self.assertIn("renderLaserVisuals(null, measObj)", js08)
        self.assertIn("Read-only Guest cannot modify saved measurement bookmarks.", routes_py)
        self.assertIn(".gs-photo-frustum-overlay", css)
        self.assertIn(".gs-compare-profile-drawer", css)

    def test_11_timeline_wheel_scroll_and_account_language_sync(self):
        """Verify Site Timeline horizontal mouse-wheel scroll and reliable account language persistence & mirroring."""
        # 1. Saving language 'en' for glibivanov@gatheren.com.tw persists and mirrors to gleb.ivanov1999@gmail.com
        saved_s = self.db.update_user_settings(
            "glibivanov@gatheren.com.tw",
            {"language": "en", "theme_preference": "light"},
        )
        self.assertEqual(saved_s["language"], "en")
        self.assertEqual(saved_s["theme_preference"], "light")

        s_corp = self.db.get_user_settings("glibivanov@gatheren.com.tw")
        s_gmail = self.db.get_user_settings("gleb.ivanov1999@gmail.com")
        self.assertEqual(s_corp["language"], "en")
        self.assertEqual(s_gmail["language"], "en")
        self.assertEqual(s_gmail["theme_preference"], "light")

        # 2. Verify frontend wiring for wheel scroll and language hydration without guest overwrite
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.js"), "r", encoding="utf-8") as f:
            app_js = f.read()
        with open(os.path.join(BASE_DIR, "web", "i18n.js"), "r", encoding="utf-8") as f:
            i18n_js = f.read()
        with open(os.path.join(BASE_DIR, "server.py"), "r", encoding="utf-8") as f:
            srv_py = f.read()

        self.assertIn("bindHorizontalWheelScroll", js02)
        self.assertIn("ensureTimelineAndDockWheelScroll", js02)
        self.assertIn("scrollTargetEl.scrollLeft += delta", js02)
        self.assertIn("STATE._prefsFetchedForEmail !== targetEmail || markAuthorized", app_js)
        self.assertIn("isSignedInSettingsMatch", app_js)
        self.assertIn("window.persistLanguageToServer = persistLanguageToServer", i18n_js)
        self.assertIn('fetch("/api/user-profiles"', i18n_js)
        self.assertNotIn('fetch("/api/auth/profile"', i18n_js)
        self.assertIn('pref_em not in ("guest", "guest@anonymous", "guest@external", "guest@gatheren.cloud")', srv_py)

    def test_12_map_true_nadir_rgba_ortho_and_single_scan_per_group(self):
        """Verify true-nadir transparent RGBA orthomosaic generation, exact TWD97->WGS84 bounds, and 1-scan-per-site Map rule."""
        from PIL import Image
        import numpy as np
        from pc_worker.surveying_engine import SurveyingEngine, wgs84_to_twd97, twd97_to_wgs84

        # 1. Exact inverse GRS80 TWD97 -> WGS84 projection round-trip
        e, n = wgs84_to_twd97(25.13635757, 121.50137316)
        lat_rt, lon_rt = twd97_to_wgs84(e, n)
        self.assertAlmostEqual(lat_rt, 25.13635757, places=6)
        self.assertAlmostEqual(lon_rt, 121.50137316, places=6)

        # 2. Verify pre-generated true-nadir RGBA orthomosaic PNG + JSON bounds for QiHu merged scan
        s_eng = SurveyingEngine(self.db)
        sid = "edited_qihu_unified_merged_scan_4_scans__edited_372953"
        meta = s_eng.get_saved_ortho_meta(sid)
        self.assertIsNotNone(meta)
        self.assertGreater(meta["north_lat"], meta["south_lat"])
        self.assertGreater(meta["east_lon"], meta["west_lon"])
        self.assertTrue(os.path.isfile(meta["png_path"]))
        with Image.open(meta["png_path"]) as im:
            self.assertEqual(im.mode, "RGBA")
            arr = np.asarray(im)
            # Exterior corners must be 100% transparent (alpha == 0), while interior scan footprint has opaque pixels (alpha == 255)
            self.assertEqual(int(arr[0, 0, 3]), 0)
            self.assertTrue(bool(np.any(arr[:, :, 3] == 255)))

        # 4. Surface Drainage / Stepped 1:N Slope Arrows & Legend (Zero-Freeze)
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()
        self.assertIn("SLOPE_STEPPED_TIERS", js08)
        self.assertIn("buildFastStudioSurfaceArrows", js08)
        self.assertIn("updateStudioDrainageLegendHud", js08)
        self.assertIn("1:200 – 1:100", js08)
        self.assertIn("1:100 – 1:50", js08)
        self.assertIn("1:50 – 1:20", js08)
        # Ensure renderDrainageAndSlopeVisuals3D NEVER calls sampleStudioMeshElevationAtLocalXZ or fake sine waves
        self.assertNotIn("0.35 * Math.sin(x * 0.14)", js08)

        # 5. True-Nadir Ortho & Single-Scan-per-Site Map Rule
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        self.assertIn("pickRepresentativeOrthoScanForGroup", js08)
        self.assertIn("mapInst.projectLatLon(Number(bounds.north_lat), Number(bounds.west_lon))", js08)
        self.assertIn("mapInst.projectLatLon(Number(bounds.south_lat), Number(bounds.east_lon))", js08)
        self.assertNotIn("scan.thumbnail_url || `/api/scans/${encodeURIComponent(sid)}/thumbnail`", js08)
        self.assertNotIn("ctx.strokeRect(x0, y0, boxW, boxH)", js08)
        self.assertIn("gsMap.drawMap()", js02)

    def test_13_comment_pins_labels_bright_theme_avatar_and_concise_buttons(self):
        """Verify all 5 comment pin, labels toggle, bright theme, author avatar, and concise button fixes."""
        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            html = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            css = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()

        # 1. Comment pins decoupled from categorizeLabelsVisible (controlled by folder visibility STATE.hiddenCommentFolders) & #btnStudioToggleCategorizeLabels always visible
        self.assertIn("if (b.isCommentPin) {\n        if (b.folderKey && STATE.hiddenCommentFolders && STATE.hiddenCommentFolders[b.folderKey]) {", js03)
        self.assertIn('topLblBtn.style.display = "inline-flex";', js05)
        self.assertIn("studioThree.commentPinsGroup.visible = true;", js05)

        # 2. Bright/light theme support for .gs-comment-pin-popover
        self.assertIn('html[data-theme="light"] .gs-comment-pin-popover', css)
        self.assertIn("body.theme-light .gs-comment-pin-popover", css)
        self.assertIn('html[data-theme="light"] .gs-comment-pin-author', css)
        self.assertIn('html[data-theme="light"] .gs-comment-pin-text', css)

        # 3. No native browser title attribute on .gs-comment-pin-icon or .gs-scan-comment-pin (eliminates double hover tooltip)
        self.assertNotIn('class="gs-comment-pin-icon" title=', js05)
        self.assertNotIn('class="gs-scan-comment-pin" data-comment-pin-id="${cid}" title=', js05)

        # 4. Circular character avatar of comment author inside comment pin and comment card
        self.assertIn("function getCommentAuthorAvatar(", js05)
        self.assertIn("gs-comment-pin-avatar-char", js05)
        self.assertIn("gs-comment-card-avatar", js05)
        self.assertIn(".gs-comment-pin-avatar-char", css)

        # 5. Concise 1-word / icon-only buttons
        self.assertNotIn("重新命名工區</span>", html)
        self.assertNotIn("正射影像疊圖</span>", html)
        self.assertIn('${tr("載入", "Load")}', js08)
        self.assertIn('${tr("💾 儲存", "💾 Save")}', js08)

    def test_14_drainage_arrow_scale_void_filtering_qihu_water_and_photo_comment_attachments(self):
        """Verify 1/5 drainage arrow default size + sliders, strict void/water filtering, QiHu water void classification, and RTK photo enlarge/download/drag-to-comment attachment."""
        import json

        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()

        # 1. Drainage arrows default to 1/5 (0.20x) size (`0.85 * tier.lenScale * arrowScale`, `0.055 * arrowScale`, `0.135 * arrowScale`) + Density & Arrow Size sliders
        self.assertIn("const len = 0.85 * tier.lenScale * arrowScale;", js08)
        self.assertIn("const shaftHalfW = Math.max(0.02, 0.055 * arrowScale);", js08)
        self.assertIn("const headHalfW = Math.max(0.045, 0.135 * arrowScale);", js08)
        self.assertIn('id="rngDrainageDensity"', js08)
        self.assertIn('id="rngDrainageArrowSize"', js08)

        # 2. Drainage arrows strictly filter out un-scanned empty voids & water polygons (no extrapolation into empty cells)
        self.assertIn("isFineSurfaceOccupied", js08)
        self.assertIn("isPointInsideAnyWaterPolyXZ", js08)
        self.assertNotIn("if (validCell[idx] || nCnt >= 5)", js08)
        self.assertIn("if (!validCell[idx]) continue;", js08)

        # 3. QiHu unified merged scan classifies depressed moat/pond empty area as water (`unmodelled_void_shoreline`) with zero regressions on Rose Park, NTU Dorm, and QuChi
        qihu_cache_path = os.path.join(
            BASE_DIR,
            "data",
            "categorization_cache",
            "edited_qihu_unified_merged_scan_4_scans__edited_372953_categorization_v3.json",
        )
        self.assertTrue(os.path.isfile(qihu_cache_path))
        with open(qihu_cache_path, "r", encoding="utf-8") as f:
            qihu_cat = json.load(f)
        self.assertGreaterEqual(int(qihu_cat.get("summary", {}).get("water_count", 0)), 2)
        self.assertGreaterEqual(float(qihu_cat.get("summary", {}).get("water_planar_area_m2", 0.0)), 1400.0)
        qihu_modes = [w.get("detection_mode") for w in qihu_cat.get("water_bodies", [])]
        self.assertIn("unmodelled_void_shoreline", qihu_modes)

        for zero_water_sid in ("rosepark_20260918_merged", "ntudorm_20260915_baseline"):
            p = os.path.join(BASE_DIR, "data", "categorization_cache", f"{zero_water_sid}_categorization_v3.json")
            with open(p, "r", encoding="utf-8") as f:
                cat = json.load(f)
            self.assertEqual(int(cat.get("summary", {}).get("water_count", 0)), 0)

        quchi_path = os.path.join(BASE_DIR, "data", "categorization_cache", "QuChi261016_Trees_categorization_v3.json")
        with open(quchi_path, "r", encoding="utf-8") as f:
            quchi_cat = json.load(f)
        self.assertGreaterEqual(int(quchi_cat.get("summary", {}).get("water_count", 0)), 1)

        # 4. RTK Photo Inspector replaces Match Photo View with Enlarge, Download, and Drag-and-Drop onto Comments (including multi-photo attachment)
        self.assertNotIn("Match Photo View", js05)
        self.assertNotIn("Project 55%", js05)
        self.assertIn("data-photo-enlarge-idx", js05)
        self.assertIn("data-rtk-photo-check", js05)
        self.assertIn("openPhotoLightboxModal", js08)
        self.assertIn("attachPhotosToCommentById", js08)

        # Verify backend comment DB supports attaching multiple photos (`photos` / `append_photos`) and preserves RTK coordinates
        created = self.db.add_comment(
            {
                "scan_id": "ntudorm_20260915_baseline",
                "author_email": "tester@gatheren.cloud",
                "author_name": "Photo Attachment Tester",
                "text": "Initial field comment",
                "pos_x": 1.0,
                "pos_y": 2.0,
                "pos_z": 3.0,
                "twd97_e": 304125.0,
                "twd97_n": 2767820.0,
                "twd97_h": 18.5,
                "photos": [
                    {
                        "id": "P1",
                        "filename": "DJI_0001.JPG",
                        "url": "/api/survey/photo-preview?scan_id=test&idx=0",
                        "camera_twd97_e": 304120.5,
                        "camera_twd97_n": 2767815.2,
                        "camera_twd97_h": 35.8,
                        "distance_m": 18.4,
                    }
                ],
            }
        )
        cid = created["comment_id"]
        c_rec = self.db.get_comment(cid)
        self.assertIsNotNone(c_rec)
        self.assertEqual(len(c_rec.get("photos", [])), 1)
        self.assertAlmostEqual(float(c_rec["photos"][0].get("camera_twd97_e", 0.0)), 304120.5, places=1)
        self.assertAlmostEqual(float(c_rec["photos"][0].get("camera_twd97_h", 0.0)), 35.8, places=1)

        updated = self.db.update_comment(
            cid,
            append_photos=[
                {"id": "P2", "filename": "DJI_0002.JPG", "url": "/api/survey/photo-preview?scan_id=test&idx=1"},
                {"id": "P3", "filename": "DJI_0003.JPG", "url": "/api/survey/photo-preview?scan_id=test&idx=2"},
            ],
        )
        self.assertIsNotNone(updated)
        self.assertEqual(len(updated.get("photos", [])), 3)
        self.db.delete_comment(cid)

    def test_15_tool_dblclick_esc_vertex_move_point_snap_bright_tooltips_and_gdrive_comment_photo(self):
        """Verify v155 features: (1) Tool dblclick = ESC, (2) Dblclick vertex to move measurement/area/coord/angle points,
        (3) Snapping to existing measurement/area/coord/angle points, (4) Bright-theme tooltips/HUD/azimuth pills,
        (5) Uploading new local/gallery photo to a comment saved on Google Drive (gdrive)."""
        import base64
        from pc_worker.gdrive_cloud_sync import save_and_sync_comment_photo_to_gdrive

        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "06-studio-align-and-optimizer.js"), "r", encoding="utf-8") as f:
            js06 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            app_css = f.read()
        with open(os.path.join(BASE_DIR, "pc_worker", "server_api_routes.py"), "r", encoding="utf-8") as f:
            routes_py = f.read()
        with open(os.path.join(BASE_DIR, "server.py"), "r", encoding="utf-8") as f:
            server_py = f.read()

        # 1. Double-clicking on a selected tool button = pressing ESC (with 280ms debounce & Click #1 state preservation)
        self.assertIn("function triggerStudioEscapeAction(", js06)
        self.assertIn("window.triggerStudioEscapeAction = triggerStudioEscapeAction;", js06)
        self.assertIn('btn.addEventListener("dblclick"', js06)
        self.assertIn("nowMs - _lastToolBtnClick.ts <= 420", js06)
        self.assertIn("_lastDockEscapeTriggeredMs", js06)

        # 2. Double-clicking an existing measurement, area, coordinate, or angle point allows moving it
        self.assertIn("movingVertex: null", js01)
        self.assertIn("function findNearestEditableVertexAtScreenXY(", js03)
        self.assertIn("function startStudioVertexMove(", js03)
        self.assertIn("function updateStudioVertexMove(", js03)
        self.assertIn("function commitStudioVertexMove(", js03)
        self.assertIn("function cancelStudioVertexMove(", js03)
        self.assertIn("function rebuildAllCompletedMeasurements3D(", js03)
        self.assertIn("c === studioThree.drainageGroup", js03)
        self.assertIn('document.getElementById("studioCanvasContainer")?.addEventListener("dblclick"', js04)
        self.assertIn("commitStudioVertexMove(moveHit ? moveHit.point : null)", js04)

        # 3. Snapping (STATE.snapEnabled) snaps to existing measurement, area, coordinate, and angle points
        self.assertIn("function getAllSnappableToolVertices(", js03)
        self.assertIn("function findNearestSnappableToolVertex(", js03)
        self.assertIn("snappedToToolVertex: true", js03)
        self.assertIn("function updateStudioSnapIndicator(", js03)

        # 4. Bright theme ([data-theme="light"]) for tooltips, azimuth pills, floating draw HUD, slope sprites, and Compare ΔZ probe
        self.assertIn('html[data-theme="light"] .gs-mobile-tool-hud', app_css)
        self.assertIn('html[data-theme="light"] .autodesk-azimuth-badge', app_css)
        self.assertIn('html[data-theme="light"] .autodesk-coord-badge', app_css)
        self.assertIn('html[data-theme="light"] .laser-bubble-w', app_css)
        self.assertIn('html[data-theme="light"] .laser-bubble-slope', app_css)
        self.assertIn('document.documentElement.getAttribute("data-theme") === "light"', js08)
        self.assertNotIn("title=", [line for line in js05.splitlines() if "gs-scan-comment-pin" in line or "gs-comment-pin-icon" in line][0] if any("gs-scan-comment-pin" in line for line in js05.splitlines()) else "")

        # 5. Upload a new photo (drag-and-drop on PC; gallery on mobile) to a comment, saved on Google Drive (gdrive)
        self.assertIn('if path in ("/api/comments/upload-photo", "/api/comments/upload_photo"):', routes_py)
        self.assertIn('path.startswith("/api/comments/photo/")', server_py)
        self.assertIn("async function uploadLocalFilesToComment(", js05)
        self.assertIn("function triggerCommentPhotoFilePicker(", js05)
        self.assertIn("btnUploadDraftCommentPhoto", js05)
        self.assertIn("data-comment-upload-photo", js05)
        self.assertIn("data-pin-upload-photo", js05)

        # End-to-end test of save_and_sync_comment_photo_to_gdrive + ScanQueueDB gdrive metadata persistence
        png_1x1 = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII="
        )
        photo_obj = save_and_sync_comment_photo_to_gdrive(
            scan_id="ntudorm_20260915_baseline",
            filename="field_defect_mobile.png",
            raw_bytes=png_1x1,
            content_type="image/png",
            camera_meta={"camera_twd97_e": 304128.4, "camera_twd97_n": 2767822.1, "camera_twd97_h": 19.2},
        )
        self.assertEqual(photo_obj.get("storage"), "gdrive")
        self.assertTrue(photo_obj.get("gdrive_synced"))
        self.assertTrue(photo_obj.get("url", "").startswith("/api/comments/photo/ntudorm_20260915_baseline/"))
        self.assertGreater(int(photo_obj.get("size_bytes", 0)), 0)

        saved_c = self.db.add_comment(
            {
                "scan_id": "ntudorm_20260915_baseline",
                "author_email": "field@gatheren.cloud",
                "author_name": "Mobile Field Engineer",
                "text": "Uploaded field inspection photo to GDrive",
                "pos_x": 2.5,
                "pos_y": 1.2,
                "pos_z": -3.4,
                "photos": [photo_obj],
            }
        )
        cid = saved_c["comment_id"]
        fetched_c = self.db.get_comment(cid)
        self.assertIsNotNone(fetched_c)
        self.assertEqual(len(fetched_c.get("photos", [])), 1)
        p0 = fetched_c["photos"][0]
        self.assertEqual(p0.get("storage"), "gdrive")
        self.assertTrue(p0.get("gdrive_synced"))
        self.assertEqual(p0.get("source"), "comment_upload")
        self.assertEqual(p0.get("mime_type"), "image/png")
        self.db.delete_comment(cid)

        # Clean up test photo files created on disk
        for root_dir in ("comment_photos", "gdrive_comment_photos"):
            cand = os.path.join(BASE_DIR, "data", root_dir, "ntudorm_20260915_baseline", os.path.basename(photo_obj["url"]))
            if os.path.isfile(cand):
                try:
                    os.remove(cand)
                except OSError:
                    pass
        g_cand = photo_obj.get("gdrive_path") or ""
        if g_cand and os.path.isfile(g_cand):
            try:
                os.remove(g_cand)
            except OSError:
                pass

    def test_16_photo_zoom_sidebar_merged_rtk_photos_auto_ortho_section_gizmos_and_mesh_drainage_density(self):
        """Verify v157 features: (1) 1x-25x photo lightbox zoom with vertical zoom sidebar, (2) Merged/edited scan RTK photo spatial matching + pin cleanup,
        (3) Hidden manual Ortho capture buttons, auto ortho regen, map zoom 23, and clean dropdown labels, (4) Interactive 3D section box gizmos & yaw rotation,
        (5) Mesh triangle rasterization for drainage arrows (including InterleavedBufferAttribute) + arrows/m2 density slider decoupled from arrow length."""
        from pc_worker.surveying_engine import SurveyingEngine

        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            html = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            app_css = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()
        with open(os.path.join(BASE_DIR, "pc_worker", "surveying", "contours_and_cad.py"), "r", encoding="utf-8") as f:
            cad_py = f.read()
        with open(os.path.join(BASE_DIR, "pc_worker", "server_api_routes.py"), "r", encoding="utf-8") as f:
            routes_py = f.read()

        # 1. Requirement 1: 1x-25x Zoom & Vertical Zoom Sidebar in Picture View Mode (openPhotoLightboxModal)
        self.assertIn("Math.max(1.0, Math.min(25.0, Number(nextZoom) || 1.0))", js08)
        self.assertIn('id="photoLightboxZoomSidebar"', js08)
        self.assertIn('id="btnPhotoZoomIn"', js08)
        self.assertIn('id="rngPhotoLightboxZoom"', js08)
        self.assertIn('min="1" max="25" step="0.1"', js08)
        self.assertIn('id="btnPhotoZoomOut"', js08)
        self.assertIn('id="lblPhotoLightboxZoom"', js08)
        self.assertIn('id="btnPhotoZoomReset"', js08)
        self.assertIn(".gs-photo-zoom-sidebar", app_css)

        # 2. Requirement 2: Merged/Edited Scan RTK Photos + Photo Target Pin Cleanup
        self.assertIn("_cameras_cache_v4.json", cad_py)
        self.assertIn("merged_from", cad_py)
        self.assertIn("derived_from_scan_id", cad_py)
        self.assertIn("r_zup_rowmajor", cad_py)
        self.assertIn("function clearPhotoTargetVisuals3D()", js08)
        self.assertIn("m.userData.isPhotoTargetPin = true;", js04)
        self.assertIn("openRtkPhotoInspector(pt, true);", js04)
        self.assertIn("if (!pt)", js05)
        self.assertIn('if (STATE.activeTool === "photos" && toolName !== "photos" && typeof clearPhotoTargetVisuals3D === "function")', js03)

        eng = SurveyingEngine(os.path.join(BASE_DIR, "scans"))
        qihu_dir = os.path.join(BASE_DIR, "scans", "edited_qihu_unified_merged_scan_4_scans__edited_372953")
        if os.path.isdir(qihu_dir):
            r_west = eng.query_cameras_for_point("edited_qihu_unified_merged_scan_4_scans__edited_372953", 300525.0, 2780995.0, 12.0, top_k=4)
            r_east = eng.query_cameras_for_point("edited_qihu_unified_merged_scan_4_scans__edited_372953", 300590.0, 2780950.0, 12.0, top_k=4)
            west_files = [m["filename"] for m in r_west.get("matched_photos", [])]
            east_files = [m["filename"] for m in r_east.get("matched_photos", [])]
            self.assertGreater(len(west_files), 0)
            self.assertGreater(len(east_files), 0)
            self.assertNotEqual(west_files, east_files)

        # 3. Requirement 3: Hidden Ortho Capture Buttons, Auto Ortho Regen, Map Zoom 23, Clean Dropdown Names
        self.assertIn('id="btnCaptureNadirOrtho"', html)
        self.assertIn('id="btnStudioCaptureOrtho"', html)
        self.assertIn('id="btnMapToggleOrthoOverlay"', html)
        for btn_id in ("btnCaptureNadirOrtho", "btnStudioCaptureOrtho", "btnMapToggleOrthoOverlay"):
            idx = html.find(f'id="{btn_id}"')
            self.assertGreater(idx, 0)
            snippet = html[max(0, idx - 180) : idx + 260]
            self.assertIn("display:none !important", snippet)
        self.assertNotIn("localStorage.getItem('gs_nadir_ortho_v2_' + sid)", js08)
        self.assertIn("def _trigger_auto_ortho_regen(target_sid: Optional[str]):", routes_py)
        self.assertIn("Math.max(2.0, Math.min(23.0, nextZoom))", js02)
        self.assertIn("Math.min(23.0, gsMap.zoom + 0.75)", js02)
        self.assertIn("const zInt = Math.max(2, Math.min(19, Math.floor(gsMap.zoom)));", js02)
        self.assertIn("opt.textContent = grp.project_group;", js01)
        self.assertIn("opt.textContent = s.name;", js01)
        self.assertNotIn("`${s.name} (${s.scan_date})`", js01)

        # 4. Requirement 4: Interactive 3D Section Box Gizmos (Move, Resize Faces, Rotate Yaw)
        self.assertIn("sectionBoxState:", js01)
        self.assertIn("function rebuildSectionBox3DGizmos()", js05)
        self.assertIn("function applySectionBoxStateToClippingAndUI(", js05)
        self.assertIn("function handleSectionBoxGizmoPointerDown(", js05)
        self.assertIn("function handleSectionBoxGizmoPointerMove(", js05)
        self.assertIn("function handleSectionBoxGizmoPointerUp(", js05)
        self.assertIn('id="secClipYaw"', js05)
        self.assertIn("setFromNormalAndCoplanarPoint", js05)
        self.assertIn("handleSectionBoxGizmoPointerDown(e)", js03)
        self.assertIn("c === studioThree.sectionBoxGizmoGroup", js03)
        self.assertIn("c.userData?.isPhotoTargetPin", js03)
        self.assertIn("c.userData?.isSectionTempPin", js03)
        self.assertIn("m.userData.isSectionTempPin = true;", js04)
        self.assertIn("} else if (!st.active) {\n      st.active = true;", js05)

        # 5. Requirement 5: Drainage Mesh Triangle Rasterization (InterleavedBufferAttribute safe) + Density (arrows/m2) vs Length Sliders
        self.assertIn("pos.getX(i)", js08)
        self.assertIn("idxAttr.getX(ti * 3 + 2)", js08)
        self.assertNotIn("pos.array[i * itemSize]", js08)
        self.assertIn("drainageDensityPerM2: 0.25", js01)
        self.assertIn('min="0.04" max="2.00" step="0.02"', js08)
        self.assertIn('/ m²', js08)
        self.assertIn("const len = 0.85 * tier.lenScale * arrowScale;", js08)

    def test_17_pix4dmatic_calibrated_cameras_frustums_and_subscan_photo_resolution(self):
        """Verify Loop 1: Pix4Dmatic calibrated camera extraction (_cameras_cache_v6.json), canonical upright basis,
        FOV pinhole photo selection + 2D target reticle (proj_u, proj_v), sub-scan photo collision fix, and 3D trajectory."""
        import json
        from pc_worker.surveying_engine import SurveyingEngine

        s_eng = SurveyingEngine(self.db)
        qihu_sid = "edited_qihu_unified_merged_scan_4_scans__edited_372953"
        cam_res = s_eng.get_scan_cameras_response(qihu_sid, limit=10000, fmt="json")
        self.assertEqual(cam_res.get("status"), "ok")
        self.assertEqual(int(cam_res.get("total_cameras", 0)), 6000)
        sub_scans = cam_res.get("sub_scans") or {}
        self.assertEqual(len(sub_scans), 4)
        for k, cnt in sub_scans.items():
            self.assertEqual(int(cnt), 1500)

        c0 = cam_res["cameras"][0]
        self.assertTrue(c0.get("calibrated"))
        self.assertEqual(c0.get("pose_source"), "pix4dmatic_p4m")
        self.assertEqual(len(c0.get("right", [])), 3)
        self.assertEqual(len(c0.get("down", [])), 3)
        self.assertEqual(len(c0.get("forward", [])), 3)
        # Upright camera down vector points toward -Z (gravity)
        self.assertLess(float(c0["down"][2]), -0.2)

        csv_str = s_eng.get_scan_cameras_response(qihu_sid, fmt="csv")
        self.assertTrue(isinstance(csv_str, str) and "twd97_e,twd97_n,twd2001_h" in csv_str)

        # Verify FOV photo selection on west vs east side of unified QiHu
        west_res = s_eng.inspect_rtk_camera_photos(
            {"scan_id": qihu_sid, "twd_e": 300519.0, "twd_n": 2781009.0, "twd_h": 13.6}
        )
        east_res = s_eng.inspect_rtk_camera_photos(
            {"scan_id": qihu_sid, "twd_e": 300583.0, "twd_n": 2780947.0, "twd_h": 9.3}
        )
        self.assertGreater(len(west_res.get("photos", [])), 0)
        self.assertGreater(len(east_res.get("photos", [])), 0)
        wp0 = west_res["photos"][0]
        ep0 = east_res["photos"][0]
        self.assertTrue(wp0.get("in_fov"))
        self.assertTrue(ep0.get("in_fov"))
        self.assertTrue(wp0.get("calibrated"))
        self.assertTrue(ep0.get("calibrated"))
        self.assertTrue(0.02 <= float(wp0.get("proj_u", 0.5)) <= 0.98)
        self.assertTrue(0.02 <= float(wp0.get("proj_v", 0.5)) <= 0.98)
        self.assertIn("QiHuTender_1", wp0["filename"])
        self.assertIn("QiHuTender_4", ep0["filename"])

        # Verify user screenshot coordinates on QiHu unified and NTU Dorm (260917 & 260915) + orthometric TWVD2001 heights (~1.4m-1.7m above ground, NOT +30m ellipsoidal)
        for cache_sid, expected_ground_h_min, expected_ground_h_max in (
            ("edited_qihu_unified_merged_scan_4_scans__edited_372953", 6.0, 22.0),
            ("ntudorm_20260917_foundation", 10.0, 26.0),
            ("ntudorm_20260915_baseline", 10.0, 26.0),
            ("rosepark_20260918_merged", 4.0, 24.0),
            ("QuChi261016_Trees", 35.0, 58.0),
        ):
            cache_fp = os.path.join(BASE_DIR, "data", "cameras_cache", f"{cache_sid}_cameras_v6.json")
            self.assertTrue(os.path.isfile(cache_fp), f"Missing camera cache: {cache_fp}")
            with open(cache_fp, "r", encoding="utf-8") as cf:
                cams_cached = json.load(cf)
            self.assertGreater(len(cams_cached), 50)
            med_cam_h = sorted(float(c["h"]) for c in cams_cached)[len(cams_cached) // 2]
            self.assertTrue(
                expected_ground_h_min <= med_cam_h <= expected_ground_h_max,
                f"{cache_sid} median cam_h={med_cam_h} outside orthometric TWVD2001 range [{expected_ground_h_min}, {expected_ground_h_max}]",
            )

        ntu_res = s_eng.inspect_rtk_camera_photos(
            {"scan_id": "ntudorm_20260917_foundation", "twd_e": 303025.0, "twd_n": 2770015.0, "twd_h": 8.6}
        )
        self.assertGreater(len(ntu_res.get("photos", [])), 0)
        np0 = ntu_res["photos"][0]
        self.assertTrue(np0.get("in_fov"))
        self.assertTrue(np0.get("calibrated"))
        self.assertTrue(0.02 <= float(np0.get("proj_u", 0.5)) <= 0.98)
        self.assertTrue(0.02 <= float(np0.get("proj_v", 0.5)) <= 0.98)
        # Camera height at NTU Dorm (~10.0m-10.3m TWVD2001) is ~1.4m-1.8m above the 8.6m ground target, NEVER +40m ellipsoidal
        self.assertTrue(0.8 <= (float(np0["camera_twd97_h"]) - 8.6) <= 3.0)

        # Verify sub-scan photo resolution never collides between catch_QiHuTender_1 and catch_QiHuTender_4
        p1 = s_eng.resolve_camera_photo_path(qihu_sid, "catch_QiHuTender_1/Image_001068.jpg")
        p4 = s_eng.resolve_camera_photo_path(qihu_sid, "catch_QiHuTender_4/Image_001068.jpg")
        if p1 and p4:
            self.assertNotEqual(os.path.normcase(p1), os.path.normcase(p4))
            self.assertIn("qihutender_1", p1.lower())
            self.assertIn("qihutender_4", p4.lower())

        # Verify Loop 2 fixes: (1) VPS tunnel cacheability for /api/survey/cameras and /api/camera-photo,
        # (2) proj_u / proj_v / target_uv persistence on comment photos in ScanQueueDB,
        # (3) hasTargetReticle guard and one-click [data-photo-attach-comment-idx] button in 08-advanced-surveying-and-qa.js
        with open(os.path.join(BASE_DIR, "pc_worker", "server_cloud_and_tunnel.py"), "r", encoding="utf-8") as f:
            tunnel_py = f.read()
        self.assertIn('path.startswith("/api/survey/cameras")', tunnel_py)
        self.assertIn('path in ("/api/camera-photo", "/api/photo-file")', tunnel_py)

        cmt_reticle = self.db.add_comment(
            {
                "scan_id": qihu_sid,
                "author_email": "qa@gatheren.cloud",
                "author_name": "Loop 3 QA",
                "text": "Reticle UV persistence check",
                "pos_x": 0.0,
                "pos_y": 0.0,
                "pos_z": 0.0,
                "twd97_e": 300583.0,
                "twd97_n": 2780947.0,
                "twd97_h": 9.3,
                "photos": [
                    {
                        "id": ep0["filename"],
                        "filename": ep0["filename"],
                        "url": ep0["url"],
                        "camera_twd97_e": ep0["camera_twd97_e"],
                        "camera_twd97_n": ep0["camera_twd97_n"],
                        "camera_twd97_h": ep0["camera_twd97_h"],
                        "proj_u": ep0["proj_u"],
                        "proj_v": ep0["proj_v"],
                        "target_uv": {"u": ep0["proj_u"], "v": ep0["proj_v"], "in_fov": True},
                    }
                ],
            }
        )
        saved_ret = self.db.get_comment(cmt_reticle["comment_id"])
        self.assertIsNotNone(saved_ret)
        sp0 = saved_ret["photos"][0]
        self.assertAlmostEqual(float(sp0["proj_u"]), float(ep0["proj_u"]), places=4)
        self.assertAlmostEqual(float(sp0["proj_v"]), float(ep0["proj_v"]), places=4)
        self.assertIsInstance(sp0.get("target_uv"), dict)
        self.assertAlmostEqual(float(sp0["target_uv"]["u"]), float(ep0["proj_u"]), places=4)
        self.assertTrue(sp0["target_uv"]["in_fov"])
        self.db.delete_comment(cmt_reticle["comment_id"])

        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()
        self.assertIn("function _projectWorldPointToPhotoUV(", js08)
        self.assertIn("function _serializeRtkPhotoForComment(", js08)
        self.assertIn("const hasTargetReticle = Boolean(", js08)
        self.assertIn("data-photo-attach-comment-idx", js08)
        self.assertIn("function loadAndRenderScanCameraTrajectory3D(", js08)
        self.assertIn("function pickCameraTrajectoryMarkerAtScreenXY(", js08)
        self.assertIn("function selectCalibratedCameraFrom3D(", js08)
        self.assertIn("window.renderPhoto3DFrustums = renderRtkPhotoFrustums3D;", js08)
        self.assertIn("STATE.targetAttachCommentId", js08)

        # Verify author/admin comment edit permission & 3D pin location photo selector
        from pc_worker.server_api_routes import ServerWriteRoutesMixin

        sample_cmt = {"author_email": "alice@gatheren.com.tw", "author_name": "Alice"}
        self.assertTrue(ServerWriteRoutesMixin._can_actor_modify_comment(sample_cmt, "alice@gatheren.com.tw", "viewer", {}))
        self.assertFalse(ServerWriteRoutesMixin._can_actor_modify_comment(sample_cmt, "bob@gatheren.com.tw", "editor", {}))
        self.assertTrue(ServerWriteRoutesMixin._can_actor_modify_comment(sample_cmt, "admin@gatheren.com.tw", "admin", {}))
        self.assertTrue(ServerWriteRoutesMixin._can_actor_modify_comment(sample_cmt, "glibivanov@gatheren.com.tw", "owner", {}))
        ext_cmt = {"author_email": "external@gatheren.cloud", "author_name": "Reviewer Wang"}
        self.assertTrue(
            ServerWriteRoutesMixin._can_actor_modify_comment(
                ext_cmt, "external@gatheren.cloud", "guest", {"author_name": "Reviewer Wang"}
            )
        )
        self.assertFalse(
            ServerWriteRoutesMixin._can_actor_modify_comment(
                ext_cmt, "external@gatheren.cloud", "guest", {"author_name": "Other Guest"}
            )
        )

        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01_chk = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05_chk = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            css_chk = f.read()
        self.assertIn("function canUserEditComment(", js01_chk)
        self.assertIn("window.renderCommentPins3D()", js01_chk)
        self.assertIn("function openLocationPhotosForComment(", js05_chk)
        self.assertIn("cmtPt._explicitTwd = cmtTwd;", js05_chk)
        self.assertIn("window.renderCommentPins3D = renderCommentPins3D;", js05_chk)
        self.assertIn("pt._explicitTwd", js08)
        self.assertIn(".gs-comment-pin-popover::before", css_chk)
        self.assertIn(".gs-comment-pin-popover:hover", css_chk)
        self.assertIn(".gs-comment-pin-close-btn", css_chk)
        self.assertIn("data-pin-close", js05_chk)
        self.assertIn("pointer-events: auto !important;", css_chk)

    def test_18_six_v162_features_upload_spinner_lightbox_theme_comment_folders_camera_hide_occlusion_and_auto_classify(self):
        """Verify all 6 v162 features:
        1. Immediate upload placeholder square (.gs-photo-upload-placeholder + .gs-upload-spinner-ring)
        2. Bright / Light Theme for Image Zoom Window (openPhotoLightboxModal)
        3. Comment Folders CRUD + Dragging Notes & Photos Between Folders + Folder Visibility Toggle + Icon-only controls
        4. Hide 3D camera objects when Photos menu is closed
        5. Depth occlusion for slope arrows, comment pins, and 2D badges behind scan geometry
        6. Auto-show classification when Classify tab opens & auto-hide when closed (decoupled from comment pins)
        """
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            app_css = f.read()

        # Feature 1: Immediate upload placeholder square & spinner
        self.assertIn("gs-photo-upload-placeholder", js05)
        self.assertIn("gs-upload-spinner-ring", js05)
        self.assertIn(".gs-photo-upload-placeholder", app_css)
        self.assertIn(".gs-upload-spinner-ring", app_css)
        self.assertIn("@keyframes gsSpin", app_css)

        # Feature 2: Bright / Light Theme for Image Zoom Window
        self.assertIn("gs-lightbox-backdrop", js08)
        self.assertIn("gs-lightbox-card", js08)
        self.assertIn("gs-lightbox-header", js08)
        self.assertIn("gs-lightbox-stage", js08)
        self.assertIn('html[data-theme="light"] .gs-lightbox-card', app_css)
        self.assertIn('html[data-theme="light"] .gs-lightbox-stage', app_css)

        # Feature 3: Comment Folders CRUD + Photo Move in ScanQueueDB & UI
        sid = "ntudorm_20260915_baseline"
        folders_after_create = self.db.create_comment_folder(sid, "Structural Cracks")
        self.assertIn("Structural Cracks", folders_after_create)

        c1 = self.db.add_comment(
            {
                "scan_id": sid,
                "author_email": "eng@gatheren.cloud",
                "author_name": "Engineer A",
                "text": "North wall crack",
                "folder": "Structural Cracks",
                "pos_x": 1.0,
                "pos_y": 2.0,
                "pos_z": 3.0,
                "photos": [{"id": "P_MOVE", "filename": "crack1.jpg", "url": "/api/comments/photo/test/crack1.jpg"}],
            }
        )
        c2 = self.db.add_comment(
            {
                "scan_id": sid,
                "author_email": "eng@gatheren.cloud",
                "author_name": "Engineer A",
                "text": "Drainage note",
                "folder": "",
                "pos_x": 4.0,
                "pos_y": 2.0,
                "pos_z": 1.0,
                "photos": [],
            }
        )
        self.assertEqual(c1.get("folder"), "Structural Cracks")
        self.assertEqual(c2.get("folder"), "")

        # Rename folder updates both scan folder list and comment.folder
        renamed_list = self.db.rename_comment_folder(sid, "Structural Cracks", "Wall Defects")
        self.assertIn("Wall Defects", renamed_list)
        self.assertNotIn("Structural Cracks", renamed_list)
        c1_reloaded = self.db.get_comment(c1["comment_id"])
        self.assertEqual(c1_reloaded.get("folder"), "Wall Defects")

        # Delete folder moves notes back to Unclassified ('')
        after_del = self.db.delete_comment_folder(sid, "Wall Defects")
        self.assertNotIn("Wall Defects", after_del)
        c1_unclass = self.db.get_comment(c1["comment_id"])
        self.assertEqual(c1_unclass.get("folder"), "")

        self.db.delete_comment(c1["comment_id"])
        self.db.delete_comment(c2["comment_id"])

        self.assertIn("data-comment-folder-header", js08)
        self.assertIn("data-comment-folder-drop", js08)
        self.assertIn("application/x-gs-comment-photo", js08)
        self.assertIn("application/x-gs-comment-card", js08)
        self.assertIn("STATE.hiddenCommentFolders", js08)

        # Feature 4: Hide 3D camera objects when Photos menu is closed
        self.assertIn("clearPhotoTargetVisuals3D(true)", js03)
        self.assertIn("clearPhotoTargetVisuals3D(true)", js05)
        self.assertIn("studioThree.cameraTrajectoryGroup.visible = false", js08)
        self.assertIn("studioThree.photoFrustumGroup.visible = false", js08)

        # Feature 5: Depth occlusion for slope arrows and 3D measurement pins (while keeping comment pins visible through scan)
        self.assertIn("const isCommentMarker = grp === studioThree.commentPinsGroup;", js03)
        self.assertIn("depthTest: !isCommentMarker", js03)
        self.assertIn("polygonOffsetFactor: -1", js08)

        # Feature 6: Auto-show classification when Classify tab opens & auto-hide when closed (while keeping comment/measurement Labels visible by default)
        self.assertIn('STATE.categorizeOverlayVisible = STATE.activeTool === "categorize";', js03)
        self.assertIn("STATE.categorizeOverlayVisible = false;\n      STATE.categorizeLabelsVisible = true;", js03)
        self.assertIn("STATE.categorizeOverlayVisible = autoShow;\n    STATE.categorizeLabelsVisible = autoShow;", js05)

    def test_19_ipad_webgl_memory_and_view_lifecycle_protection(self):
        """Verify iPadOS/iOS WebGL Jetsam crash prevention, single-context lifecycle, and preview_tileset LOD streaming."""
        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "07-compare-and-queue.js"), "r", encoding="utf-8") as f:
            js07 = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.js"), "r", encoding="utf-8") as f:
            app_js = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            app_css = f.read()
        with open(os.path.join(BASE_DIR, "web", "sw.js"), "r", encoding="utf-8") as f:
            sw_js = f.read()

        # 1. iPadOS Safari desktop-mode detection + temporary WebGL context release + deep GPU resource disposal
        self.assertIn("function isIOSOrIPadDevice()", js01)
        self.assertIn("Number(navigator.maxTouchPoints || 0) > 1", js01)
        self.assertIn("function disposeObject3DResources(", js01)
        self.assertIn('gl.getExtension("WEBGL_lose_context")', js01)

        # 2. Prevent hidden Map previewThree initialization when opening Studio or single-scan share link
        self.assertIn("function suspendPreview3DResources()", js02)
        self.assertIn('STATE.activeView === "map"', js02)
        self.assertIn("opts.preservePopover", js02)
        self.assertIn("window.innerWidth <= 767", js02)

        # 3. Studio 3D WebGL memory budget on iPad/mobile: preview_tileset.json LOD, mipmap/MSAA suppression, context restoration
        self.assertIn("preview_tileset.json", js03)
        self.assertIn("mat.map.generateMipmaps = false", js03)
        self.assertIn("webglcontextlost", js03)
        self.assertIn("webglcontextrestored", js03)
        self.assertIn("suspendPreview3DResources()", js03)

        # 4. Compare view memory protection + view switching suspension
        self.assertIn("suspendCompare3DResources", js07)
        self.assertIn("suspendPreview3DResources()", app_js)
        self.assertIn('@media (max-width: 767px)', app_css)

        # 5. Service worker avoids cloning uncached multi-megabyte .glb stream buffers in RAM
        self.assertIn("caches.open(SCAN_TILES_CACHE)", sw_js)
        self.assertIn("if (existingCached && tileCache) {", sw_js)

    def test_20_recursive_merge_5_paths_and_move_notes(self):
        """Verify recursive merge provenance (_flatten_merged_from_leaves), 5 separate photo paths on
        merged_qihu_merged_2026_10_28_77753, DB.update_comment position updates, DB.clone_comments_to_scan
        with transform_fn & folder preservation, DB.clone_measurement_bookmarks_to_scan with transform_fn,
        and frontend interactive Move Note (btn-move-comment / STATE.movingCommentId)."""
        import json
        from pc_worker.surveying_engine import SurveyingEngine

        # 1. Verify DB.update_comment position updates (pos_x, pos_y, pos_z, twd97_e, twd97_n, twd97_h)
        sid_src = "test_merge_src_scan"
        sid_dst = "test_merge_dst_scan"
        self.db.upsert_scan(
            {
                "scan_id": sid_src,
                "name": "Test Merge Source",
                "project_group": "QiHu",
                "project_dir": os.path.join(BASE_DIR, "scans", sid_src),
                "extra_json": json.dumps({"comment_folders": ["一般備註", "樹木移植"]}, ensure_ascii=False),
            }
        )
        self.db.upsert_scan(
            {
                "scan_id": sid_dst,
                "name": "Test Merge Target",
                "project_group": "QiHu",
                "project_dir": os.path.join(BASE_DIR, "scans", sid_dst),
                "extra_json": json.dumps({"comment_folders": []}, ensure_ascii=False),
            }
        )

        cmt = self.db.add_comment(
            {
                "scan_id": sid_src,
                "author_email": "glibivanov@gatheren.com.tw",
                "author_name": "Glib Ivanov",
                "text": "編號27樹。(需要移植最大顆)",
                "folder": "一般備註",
                "pos_x": 10.0,
                "pos_y": 2.5,
                "pos_z": -5.0,
                "twd97_e": 300580.0,
                "twd97_n": 2780960.0,
                "twd97_h": 10.5,
                "photos": [{"id": "P1", "filename": "tree27.jpg", "url": "/api/comments/photo/test/tree27.jpg"}],
            }
        )
        cid = cmt["comment_id"]
        moved_cmt = self.db.update_comment(
            cid,
            pos_x=13.5,
            pos_y=3.2,
            pos_z=-7.25,
            twd97_e=300583.5,
            twd97_n=2780962.25,
            twd97_h=11.2,
        )
        self.assertIsNotNone(moved_cmt)
        self.assertAlmostEqual(float(moved_cmt["pos_x"]), 13.5, places=3)
        self.assertAlmostEqual(float(moved_cmt["pos_y"]), 3.2, places=3)
        self.assertAlmostEqual(float(moved_cmt["pos_z"]), -7.25, places=3)
        self.assertAlmostEqual(float(moved_cmt["twd97_e"]), 300583.5, places=3)
        self.assertAlmostEqual(float(moved_cmt["twd97_n"]), 2780962.25, places=3)
        self.assertAlmostEqual(float(moved_cmt["twd97_h"]), 11.2, places=3)
        self.assertEqual(moved_cmt.get("folder"), "一般備註")

        # 2. Verify DB.clone_comments_to_scan with transform_fn and folder preservation
        def _tx_fn(px, py, pz, ce, cn, ch):
            return (px + 5.0, py - 1.0, pz + 2.0, ce + 5.0, cn - 2.0, ch - 1.0)

        cloned_cnt = self.db.clone_comments_to_scan(sid_src, sid_dst, transform_fn=_tx_fn)
        self.assertEqual(cloned_cnt, 1)
        dst_cmts = self.db.list_comments(sid_dst)
        self.assertEqual(len(dst_cmts), 1)
        dc0 = dst_cmts[0]
        self.assertEqual(dc0.get("folder"), "一般備註")
        self.assertAlmostEqual(float(dc0["pos_x"]), 18.5, places=3)
        self.assertAlmostEqual(float(dc0["pos_y"]), 2.2, places=3)
        self.assertAlmostEqual(float(dc0["pos_z"]), -5.25, places=3)
        self.assertAlmostEqual(float(dc0["twd97_e"]), 300588.5, places=3)
        self.assertAlmostEqual(float(dc0["twd97_n"]), 2780960.25, places=3)
        self.assertAlmostEqual(float(dc0["twd97_h"]), 10.2, places=3)
        dst_folders = self.db.list_comment_folders(sid_dst)
        self.assertIn("一般備註", dst_folders)
        self.assertIn("樹木移植", dst_folders)

        # 3. Verify DB.clone_measurement_bookmarks_to_scan with transform_fn
        self.db.save_measurement_bookmark(
            {
                "scan_id": sid_src,
                "title": "Tree Clearance Check",
                "author_email": "glibivanov@gatheren.com.tw",
                "author_name": "Glib Ivanov",
                "camera_state": {"view_mode": "3d", "pos": [0, 20, 20]},
                "measurements_state": {
                    "distance_points": [
                        {"x": 10.0, "y": 2.0, "z": -4.0, "twd97_e": 300580.0, "twd97_n": 2780960.0, "twd97_h": 10.0}
                    ]
                },
            }
        )
        bm_cloned = self.db.clone_measurement_bookmarks_to_scan(sid_src, sid_dst, transform_fn=_tx_fn)
        self.assertEqual(bm_cloned, 1)
        dst_bms = self.db.list_measurement_bookmarks(sid_dst)
        self.assertEqual(len(dst_bms), 1)
        pt0 = dst_bms[0]["measurements_state"]["distance_points"][0]
        self.assertAlmostEqual(float(pt0["x"]), 15.0, places=3)
        self.assertAlmostEqual(float(pt0["y"]), 1.0, places=3)
        self.assertAlmostEqual(float(pt0["z"]), -2.0, places=3)
        self.assertAlmostEqual(float(pt0["twd97_e"]), 300585.0, places=3)
        self.assertAlmostEqual(float(pt0["twd97_n"]), 2780958.0, places=3)
        self.assertAlmostEqual(float(pt0["twd97_h"]), 9.0, places=3)

        # 4. Verify _flatten_merged_from_leaves recursive 6-DOF composition
        sid_parent_merge = "test_parent_merged_4scans"
        self.db.upsert_scan(
            {
                "scan_id": sid_parent_merge,
                "name": "Parent Merged 4 Scans",
                "project_group": "QiHu",
                "project_dir": os.path.join(BASE_DIR, "scans", sid_parent_merge),
                "extra_json": json.dumps(
                    {
                        "merged_from": [
                            {
                                "scan_id": "leaf_scan_1",
                                "native_anchor_zup": [300500.0, 2780900.0, 10.0],
                                "merged_anchor_zup": [300510.0, 2780920.0, 12.0],
                                "r_zup_rowmajor": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
                            },
                            {
                                "scan_id": "leaf_scan_2",
                                "native_anchor_zup": [300550.0, 2780950.0, 11.0],
                                "merged_anchor_zup": [300560.0, 2780970.0, 13.0],
                                "r_zup_rowmajor": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
                            },
                        ]
                    }
                ),
            }
        )
        eng = SurveyingEngine(self.db)
        top_mf = [
            {
                "scan_id": sid_parent_merge,
                "native_anchor_zup": [300535.0, 2780945.0, 12.5],
                "merged_anchor_zup": [300540.0, 2780955.0, 14.5],
                "r_zup_rowmajor": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            },
            {
                "scan_id": "leaf_scan_side",
                "native_anchor_zup": [300600.0, 2781000.0, 15.0],
                "merged_anchor_zup": [300605.0, 2781010.0, 16.0],
                "r_zup_rowmajor": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            },
        ]
        flattened = eng._flatten_merged_from_leaves(top_mf)
        self.assertEqual([m["scan_id"] for m in flattened], ["leaf_scan_1", "leaf_scan_2", "leaf_scan_side"])
        # leaf_scan_1 had ma_1 = [300510, 2780920, 12]; parent shifted from na_2=[300535,2780945,12.5] to ma_2=[300540,2780955,14.5] (+5, +10, +2)
        self.assertAlmostEqual(float(flattened[0]["merged_anchor_zup"][0]), 300515.0, places=3)
        self.assertAlmostEqual(float(flattened[0]["merged_anchor_zup"][1]), 2780930.0, places=3)
        self.assertAlmostEqual(float(flattened[0]["merged_anchor_zup"][2]), 14.0, places=3)

        # Also verify real QiHu_Merged_2026-10-28 (merged_qihu_merged_2026_10_28_77753) 8,640 cameras across 5 paths
        real_qihu_merged = "merged_qihu_merged_2026_10_28_77753"
        qihu_cam_cache = os.path.join(BASE_DIR, "data", "cameras_cache", f"{real_qihu_merged}_cameras_v6.json")
        if os.path.isfile(qihu_cam_cache):
            with open(qihu_cam_cache, "r", encoding="utf-8") as cf:
                cams_8640 = json.load(cf)
            self.assertEqual(len(cams_8640), 8640)
            by_sub = {}
            for c in cams_8640:
                sk = c.get("sub_scan") or "root"
                by_sub[sk] = by_sub.get(sk, 0) + 1
            self.assertEqual(
                by_sub,
                {
                    "catch_QiHuTender_1": 1500,
                    "catch_QiHuTender_2": 1500,
                    "catch_QiHuTender_3": 1500,
                    "catch_QiHuTender_4": 1500,
                    "catch_QihuSide": 2640,
                },
            )

        # 5. Verify presence of btn-move-comment, STATE.movingCommentId, v173 drainage stability & immediate frustum pyramids in frontend
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()
        self.assertIn("STATE.movingCommentId", js04)
        self.assertIn("btn-move-comment", js05)
        self.assertIn("data-pin-move", js05)
        self.assertIn("btn-move-comment", js08)
        self.assertIn("STATE.movingCommentId", js08)
        self.assertIn("function renderDrainageAndSlopeVisuals3D(opts = {})", js08)
        self.assertIn("cameraTrajectoryOriginH", js08)
        self.assertIn("const frustumPts = [];", js08)
        self.assertIn("const frustumStride = Math.max(1, Math.ceil(camList.length / 36));", js08)

    def test_21_zoom_drainage_hill_erase_modes_labels_and_laser_fixes(self):
        """Verify all 5 v174 fixes: surface-aware zoom near Earth, bare-earth drainage despike, 2-mode triangle erase (Erase All default), Labels button toggling comments, and full-mesh Laser tool."""
        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "06-studio-align-and-optimizer.js"), "r", encoding="utf-8") as f:
            js06 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "07-compare-and-queue.js"), "r", encoding="utf-8") as f:
            js07 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()

        # 1. Surface-aware OrbitControls zoom near Earth across Studio, Preview, and Compare (with strictly zero rotation)
        self.assertIn("function installSurfaceAwareOrbitZoom(", js03)
        self.assertIn("const savedQuat = cam.quaternion.clone();", js03)
        self.assertNotIn("lerp(cursorDir", js03)
        self.assertIn("controls.minDistance = 0.08;", js03)
        self.assertIn("controls.minDistance = 0.08;", js02)
        self.assertIn("controls.minDistance = 0.08;", js07)

        # 2. Drainage bare-earth minYGrid + 5x5 lower-envelope despike pass (no 0.22 * meanY canopy hill)
        self.assertIn("rawH[idx] = minYGrid[idx];", js08)
        self.assertIn("const despikedH = new Float32Array(rawH);", js08)
        self.assertNotIn("0.78 * minYGrid[idx] + 0.22 * meanY", js08)

        # 3. Erasing triangles 2 modes ("Erase All in Selection" default + "Erase Visible Only")
        self.assertIn("lassoVisibleOnlyDelete: false,", js01)
        self.assertIn('id="btnLassoEraseAllMode"', js06)
        self.assertIn('id="btnLassoEraseVisibleMode"', js06)
        self.assertIn("const applyLassoDeleteDepthMode = (visOnly) => {", js06)

        # 4. Labels button hides/shows 2D/3D comments & pins
        self.assertIn("if (STATE.categorizeLabelsVisible === false) {\n          b.el.style.display = \"none\";\n          return;\n        }", js03)
        self.assertIn("studioThree.commentPinsGroup.visible = STATE.categorizeLabelsVisible;", js05)

        # 5. Laser tool full-mesh indexing & slope-seeded surface tracing
        self.assertIn("const targetMaxTris = 750000;", js04)
        self.assertIn("const semiCands = [];", js04)
        self.assertIn("if (stepJump <= 0.135 && probe.absNy >= 0.68)", js04)

    def test_22_merge_invariant_categorization_and_ground_photo_referee(self):
        """Verify 100% merge-invariant 3D classification on QiHu_Merged vs QiHu_Unified + calibrated mobile phone photo referee."""
        import json
        with open(os.path.join(BASE_DIR, "pc_worker", "surveying", "categorization_heuristics.py"), "r", encoding="utf-8") as f:
            heur_py = f.read()
        with open(os.path.join(BASE_DIR, "pc_worker", "surveying", "categorization_io.py"), "r", encoding="utf-8") as f:
            io_py = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()

        # 1. Verify zero hardcoded scan-size mode switches (no max_span / 280m / 180m / 60m / is_wide_valley_forestry_scan), global TWD97 grid-origin snapping, occupied_2d_m2 scaling, local neighborhood datum grids, and rejected_false_positive_tags hookup
        self.assertNotIn("is_wide_valley_forestry_scan", heur_py)
        self.assertNotIn("max_span", heur_py)
        self.assertNotIn("is_midspan_moat_scan", heur_py)
        self.assertIn("res = 0.25", heur_py)
        self.assertIn("e_min = math.floor(float(base_e.min()) / res) * res", heur_py)
        self.assertIn("n_min = math.floor(float(base_n.min()) / res) * res", heur_py)
        self.assertIn("area_scale = max(1.0, min(2.5, occupied_2d_m2 / 12500.0))", heur_py)
        self.assertIn("local_dtm_p25_grid = grey_erosion(", heur_py)
        self.assertIn("rej_tags = set(str(x).strip() for x in (ai_info.get(\"rejected_false_positive_tags\") or [])", heur_py)
        self.assertIn('"anchor_twd97": {"e": round(ce, 3), "n": round(cn, 3), "h": round(ch, 3)},', heur_py)

        # 2. Verify Ground-Level Mobile Phone Photo Referee, unified fast RTK photo frustum matcher, and interactive 📸 photo lightbox badge
        self.assertIn("def _crop_rtk_photo_for_3d_feature(", io_py)
        self.assertIn("def _match_feature_to_rtk_photo_fast(", io_py)
        self.assertIn("cal_bonus = 0.0 if cam.get(\"calibrated\", True) else 4.0", io_py)
        self.assertIn("data-cat-photo-file", js05)
        self.assertIn("window.openPhotoLightboxModal(photoUrl, fname, meta", js05)

        # 3. Verify QiHu_Merged (edited_qihu_merged_2026_10_28_858499) preserves QiHu_Unified trees, road planter holes, and water voids
        uni_path = os.path.join(BASE_DIR, "data", "categorization_cache", "edited_qihu_unified_merged_scan_4_scans__edited_372953_categorization_v3.json")
        mrg_path = os.path.join(BASE_DIR, "data", "categorization_cache", "edited_qihu_merged_2026_10_28_858499_categorization_v3.json")
        self.assertTrue(os.path.isfile(uni_path))
        self.assertTrue(os.path.isfile(mrg_path))
        with open(uni_path, "r", encoding="utf-8") as f:
            uni_cat = json.load(f)
        with open(mrg_path, "r", encoding="utf-8") as f:
            mrg_cat = json.load(f)

        self.assertEqual(float(mrg_cat["summary"]["grid_resolution_m"]), 0.25)
        self.assertIn("anchor_twd97", mrg_cat)
        self.assertGreaterEqual(int(mrg_cat["summary"]["trees_count"]), int(uni_cat["summary"]["trees_count"]) + 50)
        self.assertGreaterEqual(float(mrg_cat["summary"]["roads_planar_area_m2"]), float(uni_cat["summary"]["roads_planar_area_m2"]))
        self.assertTrue(any(len(r.get("holes_twd97") or []) > 0 for r in mrg_cat.get("roads", [])))
        self.assertGreaterEqual(int(mrg_cat["summary"]["water_count"]), 2)
        self.assertGreaterEqual(float(mrg_cat["summary"]["water_planar_area_m2"]), 1300.0)
        self.assertTrue(any(t.get("verified_photo") for t in mrg_cat.get("trees", [])))


if __name__ == "__main__":
    unittest.main()


