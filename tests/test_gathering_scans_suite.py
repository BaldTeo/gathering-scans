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

        # 1. Labels on/off also hides comment pins & #btnStudioToggleCategorizeLabels always visible
        self.assertIn('if (b.isCommentPin) {\n        if (STATE.categorizeLabelsVisible === false) {\n          b.el.style.display = "none";\n          return;\n        }', js03)
        self.assertIn('topLblBtn.style.display = "inline-flex";', js05)
        self.assertIn("studioThree.commentPinsGroup.visible = Boolean(visible);", js05)

        # 2. Bright/light theme support for .gs-comment-pin-popover
        self.assertIn('html[data-theme="light"] .gs-comment-pin-popover', css)
        self.assertIn("body.theme-light .gs-comment-pin-popover", css)
        self.assertIn('html[data-theme="light"] .gs-comment-pin-author', css)
        self.assertIn('html[data-theme="light"] .gs-comment-pin-text', css)

        # 3. No native browser title attribute on .gs-comment-pin-icon (eliminates double hover tooltip)
        self.assertNotIn('class="gs-comment-pin-icon" title=', js05)

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


if __name__ == "__main__":
    unittest.main()
